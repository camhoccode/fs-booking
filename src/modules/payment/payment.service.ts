import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Payment, PaymentDocument } from './payment.schema';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { IdempotencyService } from './idempotency.service';
import { BookingService } from '../booking/booking.service';

/**
 * Response from payment gateway (mock)
 */
interface GatewayResponse {
  success: boolean;
  transaction_id: string;
  payment_url: string;
  expires_at: Date;
}

/**
 * Payload from payment gateway webhook
 */
export interface WebhookPayload {
  transaction_id: string;
  status: 'success' | 'failed' | 'pending';
  amount: number;
  paid_at?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Response when creating payment successfully
 */
export interface CreatePaymentResponse {
  success: boolean;
  payment_id: string;
  payment_url: string;
  expires_at: Date;
  message: string;
}

/**
 * PaymentService handles payment operations with idempotency
 *
 * Architecture:
 * - Integrates with BookingService for seat confirmation/release
 * - On payment success: calls BookingService.confirmSeatsAfterPayment()
 * - On payment failed: calls BookingService.releaseSeatsAfterPaymentFailure()
 *
 * Double-click Prevention:
 * - Each payment request requires X-Idempotency-Key header
 * - Same key returns same response, does not create new payment
 * - Payment has unique constraint on idempotency_key
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  /**
   * Payment expiry time (15 minutes)
   */
  private readonly PAYMENT_EXPIRY_MINUTES = 15;

  constructor(
    @InjectModel(Payment.name)
    private readonly paymentModel: Model<PaymentDocument>,
    private readonly idempotencyService: IdempotencyService,
    @Inject(forwardRef(() => BookingService))
    private readonly bookingService: BookingService,
  ) {}

  /**
   * Create new payment with idempotency handling
   *
   * Flow:
   * 1. Hash request body
   * 2. Check idempotency key
   * 3. If cached response exists -> return
   * 4. Validate booking (exists, pending, not expired, no existing payment)
   * 5. Create payment with unique idempotency_key
   * 6. Call payment gateway
   * 7. Update idempotency record
   * 8. Return payment URL
   */
  async createPayment(
    dto: CreatePaymentDto,
    userId: string,
    idempotencyKey: string,
    requestPath: string,
  ): Promise<CreatePaymentResponse> {
    // Step 1: Hash request body
    const requestHash = this.idempotencyService.hashRequestBody(
      dto as unknown as Record<string, unknown>,
    );

    // Step 2: Check idempotency key
    const idempotencyCheck = await this.idempotencyService.checkIdempotencyKey(
      idempotencyKey,
      userId,
      requestPath,
      requestHash,
      'payment',
    );

    // Step 3: Return cached response if exists
    if (!idempotencyCheck.isNew && idempotencyCheck.cachedResponse) {
      this.logger.debug(
        `Returning cached response for idempotency key: ${idempotencyKey}`,
      );
      return idempotencyCheck.cachedResponse
        .body as unknown as CreatePaymentResponse;
    }

    try {
      // Step 4: Validate booking
      const booking = await this.validateBooking(dto.booking_id, userId);

      // Step 5: Check existing payment for this booking
      const existingPayment = await this.paymentModel.findOne({
        booking_id: new Types.ObjectId(dto.booking_id),
        status: { $in: ['pending', 'processing', 'completed'] },
      });

      if (existingPayment) {
        if (existingPayment.status === 'completed') {
          throw new ConflictException('Booking already paid');
        }
        if (
          existingPayment.status === 'pending' ||
          existingPayment.status === 'processing'
        ) {
          // Return existing pending payment
          const response: CreatePaymentResponse = {
            success: true,
            payment_id: existingPayment._id.toString(),
            payment_url: existingPayment.payment_url ?? '',
            expires_at: existingPayment.expires_at ?? new Date(),
            message: 'Payment already exists, please complete payment',
          };

          await this.idempotencyService.completeIdempotencyKey(
            idempotencyKey,
            userId,
            {
              status: 200,
              body: response as unknown as Record<string, unknown>,
            },
            existingPayment._id.toString(),
          );

          return response;
        }
      }

      // Step 6: Create payment record
      const paymentExpiresAt = new Date();
      paymentExpiresAt.setMinutes(
        paymentExpiresAt.getMinutes() + this.PAYMENT_EXPIRY_MINUTES,
      );

      let payment: PaymentDocument;
      try {
        payment = await this.paymentModel.create({
          booking_id: new Types.ObjectId(dto.booking_id),
          user_id: new Types.ObjectId(userId),
          amount: booking.total_amount,
          currency: 'VND',
          payment_method: dto.payment_method,
          status: 'pending',
          idempotency_key: idempotencyKey,
          return_url: dto.return_url || process.env.DEFAULT_RETURN_URL,
          expires_at: paymentExpiresAt,
        });
      } catch (error) {
        // Handle duplicate idempotency_key (race condition)
        if (this.isDuplicateKeyError(error)) {
          this.logger.warn(
            `Duplicate payment detected for idempotency key: ${idempotencyKey}`,
          );
          const existingByKey = await this.paymentModel.findOne({
            idempotency_key: idempotencyKey,
          });

          if (existingByKey) {
            const response: CreatePaymentResponse = {
              success: true,
              payment_id: existingByKey._id.toString(),
              payment_url: existingByKey.payment_url ?? '',
              expires_at: existingByKey.expires_at ?? new Date(),
              message: 'Payment already exists',
            };

            await this.idempotencyService.completeIdempotencyKey(
              idempotencyKey,
              userId,
              {
                status: 200,
                body: response as unknown as Record<string, unknown>,
              },
              existingByKey._id.toString(),
            );

            return response;
          }
        }
        throw error;
      }

      // Step 7: Call payment gateway (mock)
      const gatewayResponse = await this.callPaymentGateway(
        payment,
        dto.payment_method,
      );

      // Update payment with gateway response
      await this.paymentModel.updateOne(
        { _id: payment._id },
        {
          $set: {
            gateway_transaction_id: gatewayResponse.transaction_id,
            payment_url: gatewayResponse.payment_url,
            status: 'processing',
          },
        },
      );

      // Step 8: Build response
      const response: CreatePaymentResponse = {
        success: true,
        payment_id: payment._id.toString(),
        payment_url: gatewayResponse.payment_url,
        expires_at: paymentExpiresAt,
        message: 'Please complete payment within 15 minutes',
      };

      // Update idempotency record with response
      await this.idempotencyService.completeIdempotencyKey(
        idempotencyKey,
        userId,
        { status: 201, body: response as unknown as Record<string, unknown> },
        payment._id.toString(),
      );

      this.logger.log(
        `Payment created: ${payment._id} for booking: ${dto.booking_id}`,
      );

      return response;
    } catch (error) {
      // Fail idempotency key with error
      const statusCode =
        error instanceof BadRequestException
          ? 400
          : error instanceof NotFoundException
            ? 404
            : error instanceof ConflictException
              ? 409
              : 500;

      await this.idempotencyService.failIdempotencyKey(
        idempotencyKey,
        userId,
        error instanceof Error ? error : new Error('Unknown error'),
        statusCode,
      );

      throw error;
    }
  }

  /**
   * Handle webhook from payment gateway
   *
   * On payment success: calls BookingService.confirmSeatsAfterPayment()
   * On payment failed: calls BookingService.releaseSeatsAfterPaymentFailure()
   *
   * Idempotent handling:
   * - If payment already completed -> return OK (no reprocessing)
   * - Uses optimistic locking to prevent race condition
   */
  async handleWebhook(
    provider: string,
    payload: WebhookPayload,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(
      `Processing webhook from ${provider}: ${payload.transaction_id}`,
    );

    // Validate provider
    if (!['momo', 'vnpay', 'zalopay', 'card'].includes(provider)) {
      throw new BadRequestException(`Invalid payment provider: ${provider}`);
    }

    // Find payment by gateway_transaction_id
    const payment = await this.paymentModel.findOne({
      gateway_transaction_id: payload.transaction_id,
    });

    if (!payment) {
      this.logger.warn(
        `Payment not found for transaction: ${payload.transaction_id}`,
      );
      throw new NotFoundException(
        `Payment not found for transaction: ${payload.transaction_id}`,
      );
    }

    // Idempotent check: If already completed -> return OK
    if (payment.status === 'completed') {
      this.logger.debug(
        `Payment ${payment._id} already completed, skipping webhook`,
      );
      return {
        success: true,
        message: 'Payment already processed',
      };
    }

    // Handle failed payment
    if (payload.status === 'failed') {
      const updateResult = await this.paymentModel.updateOne(
        { _id: payment._id, status: { $ne: 'completed' } },
        {
          $set: {
            status: 'failed',
            metadata: { ...payment.metadata, webhook_payload: payload },
          },
          $inc: { version: 1 },
        },
      );

      if (updateResult.modifiedCount > 0) {
        // Release seats in Redis via BookingService
        await this.bookingService.releaseSeatsAfterPaymentFailure(
          payment.booking_id.toString(),
        );
      }

      return {
        success: true,
        message: 'Payment marked as failed',
      };
    }

    // Handle successful payment with optimistic locking
    if (payload.status === 'success') {
      const updateResult = await this.paymentModel.updateOne(
        {
          gateway_transaction_id: payload.transaction_id,
          status: { $ne: 'completed' }, // Optimistic lock
        },
        {
          $set: {
            status: 'completed',
            paid_at: payload.paid_at ? new Date(payload.paid_at) : new Date(),
            metadata: { ...payment.metadata, webhook_payload: payload },
          },
          $inc: { version: 1 },
        },
      );

      // If no update -> already processed by another request
      if (updateResult.modifiedCount === 0) {
        this.logger.debug(
          `Payment ${payment._id} already processed by another request`,
        );
        return {
          success: true,
          message: 'Payment already processed',
        };
      }

      // Confirm seats in Redis via BookingService
      await this.bookingService.confirmSeatsAfterPayment(
        payment.booking_id.toString(),
      );

      this.logger.log(`Payment ${payment._id} completed successfully`);

      return {
        success: true,
        message: 'Payment completed successfully',
      };
    }

    return {
      success: true,
      message: 'Webhook processed',
    };
  }

  /**
   * Get payment by ID
   */
  async getPaymentById(
    paymentId: string,
    userId: string,
  ): Promise<PaymentDocument> {
    if (!Types.ObjectId.isValid(paymentId)) {
      throw new BadRequestException('Invalid payment ID');
    }

    const payment = await this.paymentModel.findOne({
      _id: new Types.ObjectId(paymentId),
      user_id: new Types.ObjectId(userId),
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    return payment;
  }

  /**
   * Validate booking before creating payment
   * NOTE: This uses BookingService to get booking data
   */
  private async validateBooking(
    bookingId: string,
    userId: string,
  ): Promise<{
    _id: Types.ObjectId;
    total_amount: number;
    status: string;
    expires_at: Date;
  }> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException('Invalid booking ID');
    }

    // Get booking details from BookingService
    try {
      const bookingDetails = await this.bookingService.getBooking(
        bookingId,
        userId,
      );

      // Validate booking status
      if (bookingDetails.status !== 'pending') {
        throw new BadRequestException(
          `Booking cannot be paid. Current status: ${bookingDetails.status}`,
        );
      }

      // Validate booking not expired
      if (new Date(bookingDetails.hold_expires_at) < new Date()) {
        throw new BadRequestException('Booking hold has expired');
      }

      return {
        _id: new Types.ObjectId(bookingDetails.id),
        total_amount: bookingDetails.final_amount,
        status: bookingDetails.status,
        expires_at: new Date(bookingDetails.hold_expires_at),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException('Booking not found');
      }
      throw error;
    }
  }

  /**
   * Call payment gateway (mock implementation)
   */
  private async callPaymentGateway(
    payment: PaymentDocument,
    method: string,
  ): Promise<GatewayResponse> {
    this.logger.debug(`Calling ${method} gateway for payment ${payment._id}`);

    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    const transactionId = `TXN_${method.toUpperCase()}_${uuidv4().slice(0, 8)}`;

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.PAYMENT_EXPIRY_MINUTES);

    return {
      success: true,
      transaction_id: transactionId,
      payment_url: `https://payment.example.com/${method}/pay/${transactionId}`,
      expires_at: expiresAt,
    };
  }

  /**
   * Check for MongoDB duplicate key error
   */
  private isDuplicateKeyError(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as { code: number }).code === 11000
    );
  }
}
