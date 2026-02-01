import {
  createParamDecorator,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Header name for idempotency key
 */
export const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';

/**
 * UUID v4 regex - Standardized validation across the application
 * This is the only accepted format for idempotency keys
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Custom decorator to extract idempotency key from request header
 *
 * @example
 * ```typescript
 * @Post('/hold')
 * async holdSeats(
 *   @IdempotencyKey() idempotencyKey: string,
 *   @Body() dto: HoldSeatsDto
 * ) {
 *   // idempotencyKey is extracted from X-Idempotency-Key header
 * }
 * ```
 */
export const IdempotencyKey = createParamDecorator(
  (required: boolean = true, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const idempotencyKey = request.headers[IDEMPOTENCY_KEY_HEADER] as string;

    if (required && !idempotencyKey) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
        message: `Header '${IDEMPOTENCY_KEY_HEADER}' is required`,
        timestamp: new Date().toISOString(),
        path: request.url,
      });
    }

    // Validate idempotency key format (UUID v4 only - standardized)
    if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency key must be a valid UUID v4. Example: 550e8400-e29b-41d4-a716-446655440000',
        timestamp: new Date().toISOString(),
        path: request.url,
      });
    }

    return idempotencyKey;
  },
);

/**
 * Validate idempotency key format
 * Accepts: UUID v4 only (standardized across the application)
 */
function isValidIdempotencyKey(key: string): boolean {
  return UUID_V4_REGEX.test(key);
}
