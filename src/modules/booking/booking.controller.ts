import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { HoldSeatsDto, ConfirmBookingDto } from './dto';
import {
  HoldSeatsResponse,
  ConfirmBookingResponse,
  BookingDetailsResponse,
  CancelBookingResponse,
} from './interfaces';
import { AuthGuard } from '../../common/guards';
import { IdempotencyKey, CurrentUser } from '../../common/decorators';

/**
 * BookingController handles all booking-related HTTP endpoints
 *
 * Endpoints:
 * - POST /api/bookings/hold - Hold seats for a showtime
 * - POST /api/bookings/:id/confirm - Confirm booking and initiate payment
 * - GET /api/bookings/:id - Get booking details
 * - DELETE /api/bookings/:id - Cancel booking
 *
 * All endpoints require authentication via AuthGuard.
 * Hold and Confirm operations require X-Idempotency-Key header.
 *
 * Architecture:
 * - Redis is the source of truth for seat availability (real-time, atomic)
 * - MongoDB is the persistent storage for booking records
 */
@Controller('api/bookings')
@UseGuards(AuthGuard)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  /**
   * Hold seats for a showtime
   *
   * Creates a pending booking with held seats using Redis Lua atomic operations.
   * Seats are held for 10 minutes before automatic expiration.
   *
   * @header X-Idempotency-Key - Required. Unique key to prevent duplicate bookings.
   * @header Authorization - Required. Bearer token.
   *
   * @example
   * POST /api/bookings/hold
   * Headers: { "X-Idempotency-Key": "uuid-v4", "Authorization": "Bearer token" }
   * Body: { "showtime_id": "64a7b8c9d0e1f2a3b4c5d6e7", "seats": ["A1", "A2"] }
   *
   * Response 201: {
   *   "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
   *   "booking_code": "BK-ABC12345",
   *   "showtime_id": "64a7b8c9d0e1f2a3b4c5d6e7",
   *   "seats": ["A1", "A2"],
   *   "total_amount": 200000,
   *   "final_amount": 200000,
   *   "currency": "VND",
   *   "status": "pending",
   *   "held_at": "2024-01-15T10:30:00.000Z",
   *   "hold_expires_at": "2024-01-15T10:40:00.000Z",
   *   "created_at": "2024-01-15T10:30:00.000Z"
   * }
   *
   * Error 409: Seats not available
   * Error 400: Invalid showtime or seats
   * Error 404: Showtime not found
   */
  @Post('hold')
  @HttpCode(HttpStatus.CREATED)
  async holdSeats(
    @Body() dto: HoldSeatsDto,
    @CurrentUser('id') userId: string,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<HoldSeatsResponse> {
    return this.bookingService.holdSeats(dto, userId, idempotencyKey);
  }

  /**
   * Confirm booking and initiate payment
   *
   * Validates the booking is still valid (not expired) and creates a payment request.
   * Returns a payment URL for the user to complete payment.
   *
   * @header X-Idempotency-Key - Required. Unique key to prevent duplicate payments.
   * @header Authorization - Required. Bearer token.
   *
   * @example
   * POST /api/bookings/64a7b8c9d0e1f2a3b4c5d6e8/confirm
   * Headers: { "X-Idempotency-Key": "uuid-v4", "Authorization": "Bearer token" }
   * Body: { "payment_method": "momo", "return_url": "https://app.com/callback" }
   *
   * Response 200: {
   *   "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
   *   "booking_code": "BK-ABC12345",
   *   "payment_id": "PAY_uuid-v4",
   *   "payment_url": "https://payment.example.com/pay?...",
   *   "expires_at": "2024-01-15T10:40:00.000Z"
   * }
   *
   * Error 400: Booking expired or invalid status
   * Error 403: Not booking owner
   * Error 404: Booking not found
   */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmBooking(
    @Param('id') bookingId: string,
    @Body() dto: ConfirmBookingDto,
    @CurrentUser('id') userId: string,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<ConfirmBookingResponse> {
    return this.bookingService.confirmBooking(
      bookingId,
      dto,
      userId,
      idempotencyKey,
    );
  }

  /**
   * Get booking details
   *
   * Returns detailed information about a booking.
   * User can only view their own bookings.
   *
   * @header Authorization - Required. Bearer token.
   *
   * @example
   * GET /api/bookings/64a7b8c9d0e1f2a3b4c5d6e8
   * Headers: { "Authorization": "Bearer token" }
   *
   * Response 200: {
   *   "id": "64a7b8c9d0e1f2a3b4c5d6e8",
   *   "booking_code": "BK-ABC12345",
   *   "showtime_id": "64a7b8c9d0e1f2a3b4c5d6e7",
   *   "user_id": "user123",
   *   "seats": [{ "seat_id": "A1", "seat_type": "standard", "price": 100000 }],
   *   "total_amount": 200000,
   *   "discount_amount": 0,
   *   "final_amount": 200000,
   *   "currency": "VND",
   *   "status": "pending",
   *   "held_at": "2024-01-15T10:30:00.000Z",
   *   "hold_expires_at": "2024-01-15T10:40:00.000Z",
   *   "created_at": "2024-01-15T10:30:00.000Z",
   *   "updated_at": "2024-01-15T10:30:00.000Z"
   * }
   *
   * Error 403: Not booking owner
   * Error 404: Booking not found
   */
  @Get(':id')
  async getBooking(
    @Param('id') bookingId: string,
    @CurrentUser('id') userId: string,
  ): Promise<BookingDetailsResponse> {
    return this.bookingService.getBooking(bookingId, userId);
  }

  /**
   * Cancel a booking
   *
   * Cancels a pending booking and releases held seats in Redis.
   * Only pending bookings can be cancelled by the user.
   *
   * @header Authorization - Required. Bearer token.
   *
   * @example
   * DELETE /api/bookings/64a7b8c9d0e1f2a3b4c5d6e8
   * Headers: { "Authorization": "Bearer token" }
   *
   * Response 200: {
   *   "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
   *   "booking_code": "BK-ABC12345",
   *   "status": "cancelled",
   *   "cancelled_at": "2024-01-15T10:35:00.000Z",
   *   "seats_released": ["A1", "A2"]
   * }
   *
   * Error 400: Booking cannot be cancelled (not pending)
   * Error 403: Not booking owner
   * Error 404: Booking not found
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancelBooking(
    @Param('id') bookingId: string,
    @CurrentUser('id') userId: string,
  ): Promise<CancelBookingResponse> {
    return this.bookingService.cancelBooking(bookingId, userId);
  }
}
