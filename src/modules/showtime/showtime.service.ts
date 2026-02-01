import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SeatReservationService } from '../redis/seat-reservation.service';
import {
  SeatInfo as RedisSeatInfo,
  SeatType as RedisSeatType,
} from '../redis/interfaces/seat-reservation.interface';
import {
  Showtime,
  ShowtimeDocument,
  ShowtimeStatus,
  SeatType,
  SeatStatus,
} from './showtime.schema';

/**
 * Default TTL for showtime seat data in Redis (7 days)
 */
const DEFAULT_SHOWTIME_TTL_SECONDS = 86400 * 7;

/**
 * ShowtimeService handles showtime-related operations
 *
 * Responsibilities:
 * - Initialize showtime seats in Redis when a new showtime is created
 * - Sync seat data between MongoDB and Redis
 * - Get showtime details and available seats
 *
 * Architecture:
 * - Redis is the source of truth for real-time seat availability
 * - MongoDB stores persistent showtime data
 */
@Injectable()
export class ShowtimeService {
  private readonly logger = new Logger(ShowtimeService.name);

  constructor(
    @InjectModel(Showtime.name)
    private readonly showtimeModel: Model<ShowtimeDocument>,
    private readonly seatReservationService: SeatReservationService,
  ) {}

  /**
   * Initialize showtime seats in Redis
   *
   * Called when a new showtime is created or when syncing from MongoDB.
   * Sets up all seats as available in Redis for atomic reservation operations.
   *
   * @param showtimeId - The showtime ID
   * @param options - Initialization options
   * @returns Promise<void>
   *
   * @example
   * ```typescript
   * // Initialize seats for a new showtime
   * await showtimeService.initializeShowtimeSeats('64a7b8c9d0e1f2a3b4c5d6e7');
   *
   * // Force re-initialize (overwrite existing data)
   * await showtimeService.initializeShowtimeSeats('64a7b8c9d0e1f2a3b4c5d6e7', {
   *   overwrite: true,
   * });
   * ```
   */
  async initializeShowtimeSeats(
    showtimeId: string,
    options: { ttlSeconds?: number; overwrite?: boolean } = {},
  ): Promise<void> {
    const { ttlSeconds = DEFAULT_SHOWTIME_TTL_SECONDS, overwrite = false } =
      options;

    // Get showtime from MongoDB
    const showtime = await this.showtimeModel.findById(showtimeId);

    if (!showtime) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'SHOWTIME_NOT_FOUND',
        message: 'Showtime not found',
        timestamp: new Date().toISOString(),
      });
    }

    // Prepare seat info for Redis
    const seats: RedisSeatInfo[] = [];

    showtime.seats.forEach((seatInfo, seatId) => {
      seats.push({
        seatId,
        seatType: (seatInfo.seat_type || SeatType.STANDARD) as RedisSeatType,
      });
    });

    // Initialize in Redis
    await this.seatReservationService.initializeShowtime(showtimeId, seats, {
      ttlSeconds,
      overwrite,
    });

    this.logger.log(
      `Initialized ${seats.length} seats for showtime ${showtimeId} in Redis`,
    );
  }

  /**
   * Create a new showtime with seat initialization
   *
   * Creates the showtime in MongoDB and initializes seats in Redis.
   *
   * @param data - Showtime data
   * @returns Created showtime document
   */
  async createShowtime(data: {
    movie_id: string;
    cinema_id: string;
    screen_id: string;
    start_time: Date;
    end_time: Date;
    price: { standard: number; vip: number; couple: number };
    seats: Array<{ seat_id: string; seat_type: SeatType }>;
  }): Promise<ShowtimeDocument> {
    // Build seats map for MongoDB
    const seatsMap = new Map<
      string,
      { status: SeatStatus; seat_type: SeatType }
    >();
    for (const seat of data.seats) {
      seatsMap.set(seat.seat_id, {
        status: SeatStatus.AVAILABLE,
        seat_type: seat.seat_type,
      });
    }

    // Create showtime in MongoDB
    const showtime = await this.showtimeModel.create({
      movie_id: new Types.ObjectId(data.movie_id),
      cinema_id: new Types.ObjectId(data.cinema_id),
      screen_id: data.screen_id,
      start_time: data.start_time,
      end_time: data.end_time,
      price: data.price,
      total_seats: data.seats.length,
      available_seats: data.seats.length,
      seats: seatsMap,
      status: ShowtimeStatus.SCHEDULED,
      version: 0,
    });

    // Initialize seats in Redis
    await this.initializeShowtimeSeats(showtime._id.toString());

    this.logger.log(
      `Created showtime ${showtime._id} with ${data.seats.length} seats`,
    );

    return showtime;
  }

  /**
   * Get showtime by ID
   *
   * @param showtimeId - The showtime ID
   * @returns Showtime document
   */
  async getShowtimeById(showtimeId: string): Promise<ShowtimeDocument> {
    if (!Types.ObjectId.isValid(showtimeId)) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'INVALID_SHOWTIME_ID',
        message: 'Invalid showtime ID format',
        timestamp: new Date().toISOString(),
      });
    }

    const showtime = await this.showtimeModel.findById(showtimeId);

    if (!showtime) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'SHOWTIME_NOT_FOUND',
        message: 'Showtime not found',
        timestamp: new Date().toISOString(),
      });
    }

    return showtime;
  }

  /**
   * Get available seats for a showtime from Redis
   *
   * Returns real-time seat availability from Redis (source of truth).
   *
   * @param showtimeId - The showtime ID
   * @returns Seats status result
   */
  async getAvailableSeats(showtimeId: string) {
    // Ensure showtime exists
    await this.getShowtimeById(showtimeId);

    // Get seats status from Redis
    const seatsStatus =
      await this.seatReservationService.getSeatsStatus(showtimeId);

    return seatsStatus;
  }

  /**
   * Get available seat count from Redis (O(1) operation)
   *
   * @param showtimeId - The showtime ID
   * @returns Number of available seats
   */
  async getAvailableCount(showtimeId: string): Promise<number> {
    return this.seatReservationService.getAvailableCount(showtimeId);
  }

  /**
   * Sync showtime seats from MongoDB to Redis
   *
   * Use this to recover Redis state from MongoDB after Redis restart.
   *
   * @param showtimeId - The showtime ID
   */
  async syncShowtimeToRedis(showtimeId: string): Promise<void> {
    await this.initializeShowtimeSeats(showtimeId, { overwrite: true });
  }

  /**
   * Check if showtime is initialized in Redis
   *
   * @param showtimeId - The showtime ID
   * @returns True if initialized
   */
  async isShowtimeInitialized(showtimeId: string): Promise<boolean> {
    return this.seatReservationService.isShowtimeInitialized(showtimeId);
  }

  /**
   * Delete showtime data from Redis
   *
   * Called when a showtime is cancelled or completed.
   *
   * @param showtimeId - The showtime ID
   */
  async deleteShowtimeFromRedis(showtimeId: string): Promise<void> {
    await this.seatReservationService.deleteShowtime(showtimeId);
    this.logger.log(`Deleted showtime ${showtimeId} from Redis`);
  }

  /**
   * Cleanup expired holds for a showtime
   *
   * @param showtimeId - The showtime ID
   * @returns Cleanup result
   */
  async cleanupExpiredHolds(showtimeId: string) {
    return this.seatReservationService.cleanupExpiredHolds(showtimeId);
  }

  /**
   * Get showtimes for a movie
   *
   * @param movieId - The movie ID
   * @param options - Filter options
   * @returns Array of showtimes
   */
  async getShowtimesByMovie(
    movieId: string,
    options: {
      startDate?: Date;
      endDate?: Date;
      status?: ShowtimeStatus;
    } = {},
  ): Promise<ShowtimeDocument[]> {
    const query: Record<string, unknown> = {
      movie_id: new Types.ObjectId(movieId),
    };

    if (options.status) {
      query.status = options.status;
    } else {
      // Default to scheduled showtimes
      query.status = ShowtimeStatus.SCHEDULED;
    }

    if (options.startDate || options.endDate) {
      query.start_time = {};
      if (options.startDate) {
        (query.start_time as Record<string, Date>).$gte = options.startDate;
      }
      if (options.endDate) {
        (query.start_time as Record<string, Date>).$lte = options.endDate;
      }
    }

    return this.showtimeModel.find(query).sort({ start_time: 1 }).exec();
  }

  /**
   * Get showtimes for a cinema
   *
   * @param cinemaId - The cinema ID
   * @param options - Filter options
   * @returns Array of showtimes
   */
  async getShowtimesByCinema(
    cinemaId: string,
    options: {
      startDate?: Date;
      endDate?: Date;
      status?: ShowtimeStatus;
    } = {},
  ): Promise<ShowtimeDocument[]> {
    const query: Record<string, unknown> = {
      cinema_id: new Types.ObjectId(cinemaId),
    };

    if (options.status) {
      query.status = options.status;
    } else {
      query.status = ShowtimeStatus.SCHEDULED;
    }

    if (options.startDate || options.endDate) {
      query.start_time = {};
      if (options.startDate) {
        (query.start_time as Record<string, Date>).$gte = options.startDate;
      }
      if (options.endDate) {
        (query.start_time as Record<string, Date>).$lte = options.endDate;
      }
    }

    return this.showtimeModel.find(query).sort({ start_time: 1 }).exec();
  }
}
