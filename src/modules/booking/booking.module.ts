import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';

import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { Booking, BookingSchema } from './booking.schema';
import { Showtime, ShowtimeSchema } from '../showtime/showtime.schema';
import { PaymentModule } from '../payment/payment.module';

/**
 * BookingModule handles all booking-related functionality
 *
 * Features:
 * - Hold seats with Redis Lua atomic operations (via SeatReservationService)
 * - Confirm booking and create payment
 * - Cancel booking and release seats in Redis
 * - Automatic expired holds cleanup (scheduled task)
 *
 * Dependencies:
 * - RedisModule (global): Provides SeatReservationService and RedisService
 * - ConfigModule: For environment configuration
 * - ScheduleModule: Configured in AppModule for scheduled tasks
 * - MongooseModule: For database operations
 * - PaymentModule: For circular dependency with PaymentService
 *
 * Architecture:
 * - Redis (via SeatReservationService) is the source of truth for seat availability
 * - MongoDB is the persistent storage for booking records
 *
 * Flow:
 * 1. Reserve seats in Redis (atomic Lua script)
 * 2. Save booking to MongoDB (persistence)
 * 3. On payment success: confirm seats in Redis
 * 4. On cancel/expire: release seats in Redis
 *
 * Required Environment Variables:
 * - PAYMENT_GATEWAY_URL: Base URL for payment gateway
 * - DEFAULT_RETURN_URL: Default callback URL after payment
 */
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: Booking.name, schema: BookingSchema },
      { name: Showtime.name, schema: ShowtimeSchema },
    ]),
    forwardRef(() => PaymentModule),
  ],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
