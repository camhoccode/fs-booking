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

    // Validate idempotency key format (UUID v4 recommended)
    if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency key must be a valid UUID or alphanumeric string (8-64 chars)',
        timestamp: new Date().toISOString(),
        path: request.url,
      });
    }

    return idempotencyKey;
  },
);

/**
 * Validate idempotency key format
 * Accepts: UUID v4 or alphanumeric string (8-64 characters)
 */
function isValidIdempotencyKey(key: string): boolean {
  const uuidV4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const alphanumericRegex = /^[a-zA-Z0-9_-]{8,64}$/;

  return uuidV4Regex.test(key) || alphanumericRegex.test(key);
}
