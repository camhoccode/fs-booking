import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { RedisService } from '../redis/redis.service';
import { SeatReservationService } from '../redis/seat-reservation.service';
import { SeatType as RedisSeatType } from '../redis/interfaces/seat-reservation.interface';

import {
  Showtime,
  ShowtimeDocument,
  ShowtimeStatus,
  SeatType,
} from '../showtime/showtime.schema';

import { Booking, BookingDocument, BookingStatus } from './booking.schema';
import { HoldSeatsDto, ConfirmBookingDto } from './dto';
import {
  HoldSeatsResponse,
  ConfirmBookingResponse,
  BookingDetailsResponse,
  CancelBookingResponse,
} from './interfaces';

/**
 * Booking configuration constants
 */
const HOLD_DURATION_MINUTES = 10;
const HOLD_DURATION_SECONDS = HOLD_DURATION_MINUTES * 60;

/**
 * BookingService handles all booking-related operations
 *
 * Architecture:
 * - Redis (via SeatReservationService) is the source of truth for real-time seat availability
 * - MongoDB is the persistent storage for booking records
 *
 * Flow:
 * 1. Check idempotency
 * 2. Reserve seats in Redis (atomic Lua script)
 * 3. Save booking to MongoDB (persistence)
 * 4. On payment success: confirm seats in Redis
 * 5. On cancel/expire: release seats in Redis
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @InjectModel(Booking.name)
    private readonly bookingModel: Model<BookingDocument>,
    @InjectModel(Showtime.name)
    private readonly showtimeModel: Model<ShowtimeDocument>,
    private readonly redisService: RedisService,
    private readonly seatReservationService: SeatReservationService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Hold seats for a user using Redis Lua atomic scripts
   *
   * Flow:
   * 1. Check idempotency - return cached result if exists
   * 2. Validate showtime exists and is bookable
   * 3. Reserve seats in Redis atomically (Lua script)
   * 4. Create booking record in MongoDB
   * 5. Cache result for idempotency
   *
   * @param dto Hold seats DTO
   * @param userId User ID
   * @param idempotencyKey Unique key to prevent duplicate bookings
   * @returns Hold seats response with booking details
   */
  async holdSeats(
    dto: HoldSeatsDto,
    userId: string,
    idempotencyKey: string,
  ): Promise<HoldSeatsResponse> {
    // Step 1: Check idempotency - return cached result if exists
    const cachedResult = await this.redisService.get(
      `idempotency:hold:${idempotencyKey}`,
    );
    if (cachedResult) {
      this.logger.debug(
        `Returning cached result for idempotency key: ${idempotencyKey}`,
      );
      return JSON.parse(cachedResult) as HoldSeatsResponse;
    }

    // Check if booking with this idempotency key already exists in MongoDB
    const existingBooking = await this.bookingModel.findOne({
      idempotency_key: idempotencyKey,
    });

    if (existingBooking) {
      return this.buildHoldSeatsResponse(existingBooking);
    }

    // Step 2: Validate showtime exists and fetch pricing info
    const showtimeId = new Types.ObjectId(dto.showtime_id);
    const showtime = await this.showtimeModel.findById(showtimeId);

    if (!showtime) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'SHOWTIME_NOT_FOUND',
        message: 'Showtime not found',
        timestamp: new Date().toISOString(),
      });
    }

    this.validateShowtime(showtime);

    // Step 3: Prepare seat info with types for pricing
    const seatInfos = await this.prepareSeatInfos(showtime, dto.seats);

    // Generate booking ID upfront for Redis reservation
    const bookingId = new Types.ObjectId();

    // Step 4: Reserve seats in Redis atomically using Lua script
    const reservationResult = await this.seatReservationService.reserveSeats(
      dto.showtime_id,
      seatInfos.map((s) => ({
        seatId: s.seatId,
        seatType: s.seatType as RedisSeatType,
      })),
      bookingId.toString(),
      { holdDurationSeconds: HOLD_DURATION_SECONDS },
    );

    if (!reservationResult.success) {
      // Seats not available
      const unavailableSeats =
        reservationResult.unavailable?.map((s) => s.id) || [];
      throw new ConflictException({
        statusCode: 409,
        errorCode: 'SEATS_NOT_AVAILABLE',
        message: `Some seats are not available: ${unavailableSeats.join(', ')}`,
        details: reservationResult.unavailable,
        timestamp: new Date().toISOString(),
      });
    }

    // Step 5: Calculate amounts and create booking in MongoDB
    const now = new Date();
    const holdExpiresAt = new Date(
      now.getTime() + HOLD_DURATION_MINUTES * 60 * 1000,
    );
    const totalAmount = this.calculateTotalAmount(seatInfos);
    const bookingCode = this.generateBookingCode();

    try {
      const booking = await this.bookingModel.create({
        _id: bookingId,
        booking_code: bookingCode,
        user_id: new Types.ObjectId(userId),
        showtime_id: showtimeId,
        seats: seatInfos.map((info) => ({
          seat_id: info.seatId,
          seat_type: info.seatType,
          price: info.price,
        })),
        total_amount: totalAmount,
        discount_amount: 0,
        final_amount: totalAmount,
        currency: 'VND',
        status: BookingStatus.PENDING,
        held_at: now,
        hold_expires_at: holdExpiresAt,
        idempotency_key: idempotencyKey,
      });

      const response = this.buildHoldSeatsResponse(booking);

      // Cache result for idempotency (1 hour)
      await this.redisService.set(
        `idempotency:hold:${idempotencyKey}`,
        JSON.stringify(response),
        3600000, // 1 hour in ms
      );

      this.logger.log(
        `Successfully held ${dto.seats.length} seats for booking ${booking._id}`,
      );

      return response;
    } catch (error) {
      // Rollback: Release seats in Redis if MongoDB save fails
      this.logger.error(
        `Failed to save booking to MongoDB, rolling back Redis reservation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );

      await this.seatReservationService.releaseSeats(
        dto.showtime_id,
        bookingId.toString(),
        dto.seats,
      );

      throw new ConflictException({
        statusCode: 409,
        errorCode: 'BOOKING_FAILED',
        message: 'Failed to complete booking. Please try again.',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Validate showtime is valid for booking
   */
  private validateShowtime(showtime: ShowtimeDocument): void {
    if (showtime.status !== ShowtimeStatus.SCHEDULED) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'SHOWTIME_NOT_AVAILABLE',
        message: `Showtime is ${showtime.status} and cannot accept bookings`,
        timestamp: new Date().toISOString(),
      });
    }

    if (showtime.start_time <= new Date()) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'SHOWTIME_ALREADY_STARTED',
        message: 'Cannot book seats for a showtime that has already started',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Prepare seat info with types and prices from showtime
   */
  private async prepareSeatInfos(
    showtime: ShowtimeDocument,
    seatIds: string[],
  ): Promise<Array<{ seatId: string; seatType: string; price: number }>> {
    const seatInfos: Array<{
      seatId: string;
      seatType: string;
      price: number;
    }> = [];

    for (const seatId of seatIds) {
      const seatInfo = showtime.seats.get(seatId);

      // Seat not found in showtime
      if (!seatInfo) {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'INVALID_SEAT',
          message: `Seat ${seatId} does not exist in this showtime`,
          timestamp: new Date().toISOString(),
        });
      }

      const seatType = seatInfo.seat_type || SeatType.STANDARD;
      const price = this.getSeatPrice(showtime, seatType);

      seatInfos.push({
        seatId,
        seatType,
        price,
      });
    }

    return seatInfos;
  }

  /**
   * Get seat price based on type
   */
  private getSeatPrice(showtime: ShowtimeDocument, seatType: string): number {
    switch (seatType) {
      case SeatType.VIP:
        return showtime.price.vip;
      case SeatType.COUPLE:
        return showtime.price.couple;
      case SeatType.STANDARD:
      default:
        return showtime.price.standard;
    }
  }

  /**
   * Calculate total amount for booking
   */
  private calculateTotalAmount(
    seatInfos: Array<{ seatId: string; seatType: string; price: number }>,
  ): number {
    return seatInfos.reduce((total, info) => total + info.price, 0);
  }

  /**
   * Build hold seats response from booking document
   */
  private buildHoldSeatsResponse(booking: BookingDocument): HoldSeatsResponse {
    return {
      booking_id: booking._id.toString(),
      booking_code: booking.booking_code,
      showtime_id: booking.showtime_id.toString(),
      seats: booking.seats.map((s) => s.seat_id),
      total_amount: booking.total_amount,
      final_amount: booking.final_amount,
      currency: booking.currency,
      status: booking.status,
      held_at: booking.held_at,
      hold_expires_at: booking.hold_expires_at,
      created_at: booking.createdAt,
    };
  }

  /**
   * Confirm booking and create payment
   *
   * @param bookingId Booking ID
   * @param dto Confirm booking DTO
   * @param userId User ID
   * @param idempotencyKey Unique key to prevent duplicate confirmations
   * @returns Confirm booking response with payment URL
   */
  async confirmBooking(
    bookingId: string,
    dto: ConfirmBookingDto,
    userId: string,
    idempotencyKey: string,
  ): Promise<ConfirmBookingResponse> {
    // Check idempotency
    const cachedResult = await this.redisService.get(
      `idempotency:confirm:${idempotencyKey}`,
    );
    if (cachedResult) {
      return JSON.parse(cachedResult) as ConfirmBookingResponse;
    }

    const booking = await this.bookingModel.findById(bookingId);

    if (!booking) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate ownership
    if (booking.user_id.toString() !== userId) {
      throw new ForbiddenException({
        statusCode: 403,
        errorCode: 'BOOKING_NOT_OWNED',
        message: 'You do not have permission to confirm this booking',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate status
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'BOOKING_NOT_PENDING',
        message: `Booking is ${booking.status} and cannot be confirmed`,
        timestamp: new Date().toISOString(),
      });
    }

    // Check hold expiration
    if (booking.hold_expires_at < new Date()) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'BOOKING_HOLD_EXPIRED',
        message: 'Booking hold has expired. Please create a new booking.',
        timestamp: new Date().toISOString(),
      });
    }

    // Create payment request
    const paymentUrl = await this.createPaymentRequest(
      booking,
      dto,
      idempotencyKey,
    );

    const response: ConfirmBookingResponse = {
      booking_id: booking._id.toString(),
      booking_code: booking.booking_code,
      payment_id: `PAY_${idempotencyKey}`,
      payment_url: paymentUrl,
      expires_at: booking.hold_expires_at,
    };

    // Cache result
    await this.redisService.set(
      `idempotency:confirm:${idempotencyKey}`,
      JSON.stringify(response),
      3600000,
    );

    return response;
  }

  /**
   * Create payment request (placeholder - should be in PaymentService)
   */
  private async createPaymentRequest(
    booking: BookingDocument,
    dto: ConfirmBookingDto,
    idempotencyKey: string,
  ): Promise<string> {
    const baseUrl = this.configService.get<string>(
      'PAYMENT_GATEWAY_URL',
      'https://payment.example.com',
    );

    const returnUrl =
      dto.return_url ||
      this.configService.get<string>(
        'DEFAULT_RETURN_URL',
        'https://app.example.com/payment/callback',
      );

    return `${baseUrl}/pay?booking=${booking._id}&method=${dto.payment_method}&amount=${booking.total_amount}&return=${encodeURIComponent(returnUrl)}&key=${idempotencyKey}`;
  }

  /**
   * Get booking details
   */
  async getBooking(
    bookingId: string,
    userId: string,
  ): Promise<BookingDetailsResponse> {
    const booking = await this.bookingModel.findById(bookingId);

    if (!booking) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate ownership
    if (booking.user_id.toString() !== userId) {
      throw new ForbiddenException({
        statusCode: 403,
        errorCode: 'BOOKING_NOT_OWNED',
        message: 'You do not have permission to view this booking',
        timestamp: new Date().toISOString(),
      });
    }

    return {
      id: booking._id.toString(),
      booking_code: booking.booking_code,
      showtime_id: booking.showtime_id.toString(),
      user_id: booking.user_id.toString(),
      seats: booking.seats.map((s) => ({
        seat_id: s.seat_id,
        seat_type: s.seat_type,
        price: s.price,
      })),
      total_amount: booking.total_amount,
      discount_amount: booking.discount_amount,
      final_amount: booking.final_amount,
      currency: booking.currency,
      status: booking.status,
      held_at: booking.held_at,
      hold_expires_at: booking.hold_expires_at,
      payment_id: booking.payment_id?.toString(),
      promo_code: booking.promo_code,
      confirmed_at: booking.confirmed_at,
      cancelled_at: booking.cancelled_at,
      cancellation_reason: booking.cancellation_reason,
      created_at: booking.createdAt,
      updated_at: booking.updatedAt,
    };
  }

  /**
   * Cancel a booking and release held seats
   */
  async cancelBooking(
    bookingId: string,
    userId: string,
    reason?: string,
  ): Promise<CancelBookingResponse> {
    const booking = await this.bookingModel.findById(bookingId);

    if (!booking) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
        timestamp: new Date().toISOString(),
      });
    }

    // Validate ownership
    if (booking.user_id.toString() !== userId) {
      throw new ForbiddenException({
        statusCode: 403,
        errorCode: 'BOOKING_NOT_OWNED',
        message: 'You do not have permission to cancel this booking',
        timestamp: new Date().toISOString(),
      });
    }

    // Only pending bookings can be cancelled by user
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'BOOKING_CANNOT_BE_CANCELLED',
        message: `Booking with status ${booking.status} cannot be cancelled`,
        timestamp: new Date().toISOString(),
      });
    }

    const now = new Date();
    const seatIds = booking.seats.map((s) => s.seat_id);

    // Release seats in Redis
    await this.seatReservationService.releaseSeats(
      booking.showtime_id.toString(),
      bookingId,
      seatIds,
    );

    // Update booking status in MongoDB
    booking.status = BookingStatus.CANCELLED;
    booking.cancelled_at = now;
    booking.cancellation_reason = reason || 'Cancelled by user';
    await booking.save();

    this.logger.log(`Booking ${bookingId} cancelled by user ${userId}`);

    return {
      booking_id: booking._id.toString(),
      booking_code: booking.booking_code,
      status: booking.status,
      cancelled_at: now,
      seats_released: seatIds,
    };
  }

  /**
   * Confirm seats after successful payment
   * Called by PaymentService when payment is completed
   *
   * @param bookingId Booking ID
   * @returns Success status
   */
  async confirmSeatsAfterPayment(bookingId: string): Promise<boolean> {
    const booking = await this.bookingModel.findById(bookingId);

    if (!booking) {
      this.logger.error(`Booking ${bookingId} not found for seat confirmation`);
      return false;
    }

    const seatIds = booking.seats.map((s) => s.seat_id);

    // Confirm seats in Redis (convert from held to booked)
    const result = await this.seatReservationService.confirmSeats(
      booking.showtime_id.toString(),
      bookingId,
      seatIds,
    );

    if (result.success) {
      // Update booking status
      booking.status = BookingStatus.CONFIRMED;
      booking.confirmed_at = new Date();
      await booking.save();

      this.logger.log(
        `Booking ${bookingId} confirmed with ${result.confirmed} seats`,
      );
      return true;
    }

    this.logger.error(
      `Failed to confirm seats for booking ${bookingId}: ${result.message}`,
    );
    return false;
  }

  /**
   * Release seats after payment failure
   * Called by PaymentService when payment fails
   *
   * @param bookingId Booking ID
   * @returns Success status
   */
  async releaseSeatsAfterPaymentFailure(bookingId: string): Promise<boolean> {
    const booking = await this.bookingModel.findById(bookingId);

    if (!booking) {
      this.logger.error(`Booking ${bookingId} not found for seat release`);
      return false;
    }

    const seatIds = booking.seats.map((s) => s.seat_id);

    // Release seats in Redis
    const result = await this.seatReservationService.releaseSeats(
      booking.showtime_id.toString(),
      bookingId,
      seatIds,
    );

    if (result.success) {
      // Update booking status
      booking.status = BookingStatus.CANCELLED;
      booking.cancelled_at = new Date();
      booking.cancellation_reason = 'Payment failed';
      await booking.save();

      this.logger.log(
        `Booking ${bookingId} cancelled due to payment failure, ${result.released} seats released`,
      );
      return true;
    }

    this.logger.error(
      `Failed to release seats for booking ${bookingId}: ${result.message}`,
    );
    return false;
  }

  /**
   * Release expired holds - runs every minute
   * Finds pending bookings with expired holds and releases seats in Redis
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async releaseExpiredHolds(): Promise<void> {
    const now = new Date();

    this.logger.debug('Running expired holds cleanup job');

    // Find all expired pending bookings
    const expiredBookings = await this.bookingModel.find({
      status: BookingStatus.PENDING,
      hold_expires_at: { $lt: now },
    });

    if (expiredBookings.length === 0) {
      return;
    }

    this.logger.log(
      `Found ${expiredBookings.length} expired bookings to process`,
    );

    for (const booking of expiredBookings) {
      try {
        const seatIds = booking.seats.map((s) => s.seat_id);

        // Release seats in Redis
        await this.seatReservationService.releaseSeats(
          booking.showtime_id.toString(),
          booking._id.toString(),
          seatIds,
        );

        // Update booking status
        booking.status = BookingStatus.EXPIRED;
        booking.cancellation_reason = 'Hold expired';
        await booking.save();

        this.logger.log(
          `Expired booking ${booking._id}: released ${seatIds.length} seats`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to process expired booking ${booking._id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Generate unique booking code
   * Format: BK-XXXXXXXX (8 alphanumeric characters)
   */
  private generateBookingCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'BK-';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
