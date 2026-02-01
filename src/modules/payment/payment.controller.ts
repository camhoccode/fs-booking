import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import type { WebhookPayload } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { AuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';

/**
 * PaymentController handles payment-related HTTP endpoints
 *
 * Endpoints:
 * - POST /api/payments - Create payment (requires X-Idempotency-Key)
 * - POST /api/payments/webhook/:provider - Handle webhook from payment gateway
 * - GET /api/payments/:id - Get payment details
 *
 * Architecture:
 * - On payment success: confirms seats in Redis via BookingService
 * - On payment failed: releases seats in Redis via BookingService
 */
@Controller('api/payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * Create new payment
   *
   * @header X-Idempotency-Key - Required. UUID v4 to prevent duplicate payments.
   * @header Authorization - Required. Bearer token.
   *
   * @example
   * POST /api/payments
   * Headers: { "X-Idempotency-Key": "uuid-v4", "Authorization": "Bearer token" }
   * Body: {
   *   "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
   *   "payment_method": "momo",
   *   "return_url": "https://app.com/payment/callback"
   * }
   *
   * Response 201: {
   *   "success": true,
   *   "payment_id": "64a7b8c9d0e1f2a3b4c5d6e9",
   *   "payment_url": "https://payment.example.com/momo/pay/TXN_MOMO_abc123",
   *   "expires_at": "2024-01-15T10:45:00.000Z",
   *   "message": "Please complete payment within 15 minutes"
   * }
   *
   * Response 200: Returning cached response (duplicate request)
   * Error 400: Validation error or booking invalid
   * Error 404: Booking not found
   * Error 409: Payment already exists or booking already paid
   */
  @Post()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createPayment(
    @Body() dto: CreatePaymentDto,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @CurrentUser('id') userId: string,
    @Req() req: Request,
  ) {
    // Validate idempotency key required
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException(
        'Header X-Idempotency-Key is required. Please provide a unique UUID v4 for each request.',
      );
    }

    // Validate idempotency key format (UUID v4)
    const uuidV4Regex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidV4Regex.test(idempotencyKey)) {
      throw new BadRequestException(
        'X-Idempotency-Key must be a valid UUID v4. Example: 550e8400-e29b-41d4-a716-446655440000',
      );
    }

    const requestPath = req.path;

    return this.paymentService.createPayment(
      dto,
      userId,
      idempotencyKey,
      requestPath,
    );
  }

  /**
   * Handle webhook from payment gateway
   *
   * This endpoint is called by payment providers (MoMo, VNPay, ZaloPay, etc.)
   * when payment status changes.
   *
   * @param provider - Payment provider: 'momo' | 'vnpay' | 'zalopay' | 'card'
   *
   * @example
   * POST /api/payments/webhook/momo
   * Body: {
   *   "transaction_id": "TXN_MOMO_abc123",
   *   "status": "success",
   *   "amount": 200000,
   *   "paid_at": "2024-01-15T10:35:00.000Z"
   * }
   *
   * Response 200: { "success": true, "message": "Payment completed successfully" }
   *
   * Security Notes:
   * - In production, verify signature from payment gateway
   * - Whitelist IP addresses of payment providers
   *
   * Idempotent:
   * - Multiple webhook calls for same transaction will not cause duplicate processing
   */
  @Post('webhook/:provider')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('provider') provider: string,
    @Body() payload: WebhookPayload,
    @Headers('x-signature') signature?: string,
  ) {
    // TODO: Verify webhook signature from payment gateway in production
    // if (!this.verifyWebhookSignature(provider, payload, signature)) {
    //   throw new UnauthorizedException('Invalid webhook signature');
    // }

    // Validate payload
    if (!payload.transaction_id) {
      throw new BadRequestException('transaction_id is required');
    }

    if (
      !payload.status ||
      !['success', 'failed', 'pending'].includes(payload.status)
    ) {
      throw new BadRequestException(
        'status must be one of: success, failed, pending',
      );
    }

    return this.paymentService.handleWebhook(provider, payload);
  }

  /**
   * Get payment details by ID
   *
   * @header Authorization - Required. Bearer token.
   *
   * @example
   * GET /api/payments/64a7b8c9d0e1f2a3b4c5d6e9
   * Headers: { "Authorization": "Bearer token" }
   *
   * Response 200: {
   *   "success": true,
   *   "data": {
   *     "id": "64a7b8c9d0e1f2a3b4c5d6e9",
   *     "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
   *     "amount": 200000,
   *     "currency": "VND",
   *     "payment_method": "momo",
   *     "status": "completed",
   *     "payment_url": "https://payment.example.com/momo/pay/TXN_MOMO_abc123",
   *     "paid_at": "2024-01-15T10:35:00.000Z",
   *     "expires_at": "2024-01-15T10:45:00.000Z",
   *     "created_at": "2024-01-15T10:30:00.000Z"
   *   }
   * }
   *
   * Error 400: Invalid payment ID format
   * Error 404: Payment not found
   */
  @Get(':id')
  @UseGuards(AuthGuard)
  async getPayment(
    @Param('id') paymentId: string,
    @CurrentUser('id') userId: string,
  ) {
    const payment = await this.paymentService.getPaymentById(paymentId, userId);

    return {
      success: true,
      data: {
        id: payment._id,
        booking_id: payment.booking_id,
        amount: payment.amount,
        currency: payment.currency,
        payment_method: payment.payment_method,
        status: payment.status,
        payment_url: payment.payment_url,
        paid_at: payment.paid_at,
        expires_at: payment.expires_at,
        created_at: (payment as any).created_at,
      },
    };
  }
}
