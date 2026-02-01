import {
  Injectable,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import {
  IdempotencyKey,
  IdempotencyKeyDocument,
  ResourceType,
} from './idempotency-key.schema';

/**
 * Kết quả kiểm tra idempotency key
 */
export interface IdempotencyCheckResult {
  /**
   * true nếu đây là request mới, false nếu là request trùng
   */
  isNew: boolean;

  /**
   * Cached response nếu request đã hoàn thành trước đó
   */
  cachedResponse?: {
    status: number;
    body: Record<string, unknown>;
  };

  /**
   * Document idempotency key (nếu tìm thấy)
   */
  record?: IdempotencyKeyDocument;
}

/**
 * Response đã lưu để trả về cho duplicate request
 */
export interface CachedResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Service xử lý idempotency để prevent duplicate requests
 *
 * Flow:
 * 1. Client gửi request với header X-Idempotency-Key
 * 2. Check key trong database
 * 3. Nếu không tồn tại -> tạo mới với status 'processing'
 * 4. Nếu tồn tại và 'completed' -> return cached response
 * 5. Nếu tồn tại và 'processing' -> throw ConflictException
 * 6. Sau khi xử lý xong -> update với response
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  /**
   * Thời gian sống của idempotency key (24 giờ)
   */
  private readonly TTL_HOURS = 24;

  constructor(
    @InjectModel(IdempotencyKey.name)
    private readonly idempotencyKeyModel: Model<IdempotencyKeyDocument>,
  ) {}

  /**
   * Tạo SHA256 hash của request body
   * Đảm bảo cùng key phải có cùng request payload
   */
  hashRequestBody(body: Record<string, unknown>): string {
    const sortedBody = this.sortObjectKeys(body);
    const bodyString = JSON.stringify(sortedBody);
    return crypto.createHash('sha256').update(bodyString).digest('hex');
  }

  /**
   * Sort object keys recursively để đảm bảo consistent hashing
   */
  private sortObjectKeys(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sortObjectKeys(item));
    }

    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();

    for (const key of keys) {
      sorted[key] = this.sortObjectKeys(
        (obj as Record<string, unknown>)[key],
      );
    }

    return sorted;
  }

  /**
   * Kiểm tra và xử lý idempotency key
   *
   * @param key - Idempotency key từ client
   * @param userId - ID của user
   * @param requestPath - Path của request
   * @param requestHash - SHA256 hash của request body
   * @param resourceType - Loại resource sẽ được tạo
   * @returns IdempotencyCheckResult
   * @throws ConflictException nếu request đang được xử lý
   * @throws BadRequestException nếu key đã dùng với request body khác
   */
  async checkIdempotencyKey(
    key: string,
    userId: string,
    requestPath: string,
    requestHash: string,
    resourceType: ResourceType,
  ): Promise<IdempotencyCheckResult> {
    const userObjectId = new Types.ObjectId(userId);

    // Tìm existing record
    const existingRecord = await this.idempotencyKeyModel.findOne({
      key,
      user_id: userObjectId,
    });

    // Case 1: Key không tồn tại -> tạo mới
    if (!existingRecord) {
      try {
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + this.TTL_HOURS);

        const newRecord = await this.idempotencyKeyModel.create({
          key,
          user_id: userObjectId,
          request_path: requestPath,
          request_hash: requestHash,
          resource_type: resourceType,
          status: 'processing',
          expires_at: expiresAt,
        });

        this.logger.debug(
          `Created new idempotency key: ${key} for user: ${userId}`,
        );

        return {
          isNew: true,
          record: newRecord,
        };
      } catch (error) {
        // Handle race condition: 2 requests cùng key đến gần nhau
        if (this.isDuplicateKeyError(error)) {
          this.logger.warn(
            `Race condition detected for idempotency key: ${key}`,
          );
          // Retry check
          return this.checkIdempotencyKey(
            key,
            userId,
            requestPath,
            requestHash,
            resourceType,
          );
        }
        throw error;
      }
    }

    // Validate request hash - cùng key phải có cùng request body
    if (existingRecord.request_hash !== requestHash) {
      this.logger.warn(
        `Idempotency key ${key} reused with different request body`,
      );
      throw new BadRequestException(
        'Idempotency key đã được sử dụng với request body khác. Vui lòng sử dụng key mới.',
      );
    }

    // Case 2: Key tồn tại và đã completed -> return cached response
    if (existingRecord.status === 'completed') {
      this.logger.debug(
        `Returning cached response for idempotency key: ${key}`,
      );
      return {
        isNew: false,
        cachedResponse: {
          status: existingRecord.response_status ?? 200,
          body: existingRecord.response_body ?? {},
        },
        record: existingRecord,
      };
    }

    // Case 3: Key tồn tại và đang processing -> throw conflict
    if (existingRecord.status === 'processing') {
      this.logger.warn(
        `Duplicate request detected for idempotency key: ${key}`,
      );
      throw new ConflictException(
        'Yêu cầu thanh toán đang được xử lý. Vui lòng đợi hoặc sử dụng key mới.',
      );
    }

    // Case 4: Key tồn tại và failed -> cho phép retry với key mới
    if (existingRecord.status === 'failed') {
      this.logger.debug(
        `Previous request failed for idempotency key: ${key}, returning failed status`,
      );
      return {
        isNew: false,
        cachedResponse: {
          status: existingRecord.response_status || 500,
          body: existingRecord.response_body || {
            message: existingRecord.error_message || 'Request failed',
          },
        },
        record: existingRecord,
      };
    }

    // Fallback - không nên đến đây
    return {
      isNew: true,
      record: existingRecord,
    };
  }

  /**
   * Cập nhật idempotency key khi request hoàn thành thành công
   */
  async completeIdempotencyKey(
    key: string,
    userId: string,
    response: CachedResponse,
    resourceId?: string,
  ): Promise<void> {
    const userObjectId = new Types.ObjectId(userId);

    const updateResult = await this.idempotencyKeyModel.updateOne(
      {
        key,
        user_id: userObjectId,
        status: 'processing',
      },
      {
        $set: {
          status: 'completed',
          response_status: response.status,
          response_body: response.body,
          resource_id: resourceId ? new Types.ObjectId(resourceId) : null,
        },
      },
    );

    if (updateResult.modifiedCount === 0) {
      this.logger.warn(
        `Could not complete idempotency key: ${key}, may already be completed`,
      );
    } else {
      this.logger.debug(`Completed idempotency key: ${key}`);
    }
  }

  /**
   * Cập nhật idempotency key khi request thất bại
   */
  async failIdempotencyKey(
    key: string,
    userId: string,
    error: Error,
    statusCode: number = 500,
  ): Promise<void> {
    const userObjectId = new Types.ObjectId(userId);

    const updateResult = await this.idempotencyKeyModel.updateOne(
      {
        key,
        user_id: userObjectId,
        status: 'processing',
      },
      {
        $set: {
          status: 'failed',
          response_status: statusCode,
          response_body: {
            success: false,
            message: error.message,
          },
          error_message: error.message,
        },
      },
    );

    if (updateResult.modifiedCount === 0) {
      this.logger.warn(
        `Could not fail idempotency key: ${key}, may already be processed`,
      );
    } else {
      this.logger.debug(`Failed idempotency key: ${key} with error: ${error.message}`);
    }
  }

  /**
   * Xóa idempotency key (dùng cho cleanup hoặc testing)
   */
  async deleteIdempotencyKey(key: string, userId: string): Promise<boolean> {
    const userObjectId = new Types.ObjectId(userId);

    const result = await this.idempotencyKeyModel.deleteOne({
      key,
      user_id: userObjectId,
    });

    return result.deletedCount > 0;
  }

  /**
   * Kiểm tra lỗi duplicate key từ MongoDB
   */
  private isDuplicateKeyError(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as { code: number }).code === 11000
    );
  }
}
