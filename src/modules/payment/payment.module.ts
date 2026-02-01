import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { IdempotencyService } from './idempotency.service';
import { Payment, PaymentSchema } from './payment.schema';
import {
  IdempotencyKey,
  IdempotencyKeySchema,
} from './idempotency-key.schema';
import { BookingModule } from '../booking/booking.module';

/**
 * PaymentModule handles all payment-related functionality
 *
 * Features:
 * - Create payment with idempotency handling (double-click prevention)
 * - Handle webhook from payment gateway
 * - Query payment information
 * - Integrate with BookingService for seat confirmation/release
 *
 * Schemas:
 * - Payment: Payment information storage
 * - IdempotencyKey: Tracking idempotency keys to prevent duplicate requests
 *
 * Services:
 * - PaymentService: Payment business logic
 * - IdempotencyService: Idempotency key management
 *
 * Dependencies:
 * - MongooseModule: Database connection
 * - BookingModule: For seat confirmation/release after payment
 *
 * Architecture:
 * - On payment success: calls BookingService.confirmSeatsAfterPayment()
 * - On payment failed: calls BookingService.releaseSeatsAfterPaymentFailure()
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Payment.name,
        schema: PaymentSchema,
      },
      {
        name: IdempotencyKey.name,
        schema: IdempotencyKeySchema,
      },
    ]),
    forwardRef(() => BookingModule),
  ],
  controllers: [PaymentController],
  providers: [PaymentService, IdempotencyService],
  exports: [PaymentService, IdempotencyService],
})
export class PaymentModule {}
