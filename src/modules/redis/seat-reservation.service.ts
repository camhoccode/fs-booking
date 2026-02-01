import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RedisService } from './redis.service';
import {
  SeatInfo,
  SeatReservationResult,
  SeatConfirmationResult,
  SeatReleaseResult,
  CleanupResult,
  SeatsStatusResult,
  ReserveSeatOptions,
  InitializeShowtimeOptions,
  LuaScriptShaCache,
  SeatType,
} from './interfaces/seat-reservation.interface';

/**
 * Default hold duration for seat reservation (10 minutes)
 */
const DEFAULT_HOLD_DURATION_SECONDS = 600;

/**
 * Default TTL for showtime seat data (7 days)
 */
const DEFAULT_SHOWTIME_TTL_SECONDS = 86400 * 7;

/**
 * Redis key patterns for seat management
 */
const REDIS_KEY_PATTERNS = {
  SEATS: (showtimeId: string) => `showtime:${showtimeId}:seats`,
  AVAILABLE: (showtimeId: string) => `showtime:${showtimeId}:available`,
} as const;

/**
 * SeatReservationService handles high-throughput seat reservations using Redis Lua scripts.
 *
 * Architecture:
 * - Redis is the source of truth for real-time seat availability
 * - All operations are atomic using Lua scripts to prevent race conditions
 * - Supports 100k+ req/s through script SHA caching and pipeline operations
 * - MongoDB sync happens asynchronously for persistence
 *
 * Seat States:
 * - available: Seat can be reserved
 * - held: Seat is temporarily held, waiting for payment (has expiration)
 * - booked: Seat is permanently booked after successful payment
 *
 * @example
 * ```typescript
 * // Reserve seats atomically
 * const result = await seatReservationService.reserveSeats(
 *   'showtime-123',
 *   [{ seatId: 'A1', seatType: 'standard' }, { seatId: 'A2', seatType: 'vip' }],
 *   'booking-456',
 * );
 *
 * // Confirm after payment
 * if (paymentSuccess) {
 *   await seatReservationService.confirmSeats('showtime-123', 'booking-456', ['A1', 'A2']);
 * } else {
 *   await seatReservationService.releaseSeats('showtime-123', 'booking-456', ['A1', 'A2']);
 * }
 * ```
 */
@Injectable()
export class SeatReservationService implements OnModuleInit {
  private readonly logger = new Logger(SeatReservationService.name);

  /**
   * Cached SHA hashes for Lua scripts
   * Using EVALSHA instead of EVAL reduces network overhead and improves performance
   */
  private scriptShaCache: Partial<LuaScriptShaCache> = {};

  /**
   * Raw Lua scripts loaded from files
   * Kept in memory for fallback if EVALSHA fails (script not in cache)
   */
  private luaScripts: Record<string, string> = {};

  constructor(private readonly redisService: RedisService) {}

  /**
   * Initialize service: load and cache Lua scripts
   */
  async onModuleInit(): Promise<void> {
    await this.loadLuaScripts();
    this.logger.log('SeatReservationService initialized with Lua scripts');
  }

  /**
   * Load Lua scripts from files and cache their SHA hashes in Redis
   */
  private async loadLuaScripts(): Promise<void> {
    const scriptsDir = path.join(__dirname, 'lua-scripts');

    const scriptFiles = [
      { name: 'batchReserve', file: 'batch-seat-reservation.lua' },
      { name: 'confirmSeats', file: 'confirm-seats.lua' },
      { name: 'releaseSeats', file: 'release-seats.lua' },
      { name: 'cleanupExpiredHolds', file: 'cleanup-expired-holds.lua' },
      { name: 'getSeatsStatus', file: 'get-seats-status.lua' },
      { name: 'singleReserve', file: 'seat-reservation.lua' },
    ];

    for (const { name, file } of scriptFiles) {
      try {
        const scriptPath = path.join(scriptsDir, file);
        const script = fs.readFileSync(scriptPath, 'utf-8');
        this.luaScripts[name] = script;

        // Load script into Redis and get SHA
        const sha = await this.redisService.scriptLoad(script);
        this.scriptShaCache[name as keyof LuaScriptShaCache] = sha;

        this.logger.debug(`Loaded Lua script: ${name} (SHA: ${sha.substring(0, 8)}...)`);
      } catch (error) {
        this.logger.error(`Failed to load Lua script ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    }

    this.logger.log(`Loaded ${scriptFiles.length} Lua scripts successfully`);
  }

  /**
   * Execute a Lua script by SHA with fallback to EVAL
   */
  private async executeScript<T>(
    scriptName: keyof LuaScriptShaCache,
    keys: string[],
    args: (string | number)[],
  ): Promise<T> {
    const sha = this.scriptShaCache[scriptName];
    const script = this.luaScripts[scriptName];

    if (!sha || !script) {
      throw new Error(`Lua script not loaded: ${scriptName}`);
    }

    try {
      // Try EVALSHA first (faster)
      const result = await this.redisService.evalsha(sha, keys, args.map(String));
      return typeof result === 'string' ? JSON.parse(result) : (result as T);
    } catch (error) {
      // If NOSCRIPT error, fallback to EVAL and reload SHA
      if (error instanceof Error && error.message.includes('NOSCRIPT')) {
        this.logger.warn(`Script ${scriptName} not in cache, falling back to EVAL`);
        const result = await this.redisService.eval(script, keys, args);
        // Reload SHA for next time
        this.scriptShaCache[scriptName] = await this.redisService.scriptLoad(script);
        return typeof result === 'string' ? JSON.parse(result) : (result as T);
      }
      throw error;
    }
  }

  /**
   * Reserve multiple seats atomically using Lua script.
   *
   * All-or-nothing semantics: either all seats are reserved, or none are.
   * This can handle 100k+ req/s due to atomic Redis operations.
   *
   * @param showtimeId - The showtime identifier
   * @param seats - Array of seats to reserve
   * @param bookingId - Unique booking identifier
   * @param options - Reservation options
   * @returns Reservation result with success status
   *
   * @example
   * ```typescript
   * const result = await service.reserveSeats(
   *   'showtime-123',
   *   [{ seatId: 'A1', seatType: 'standard' }],
   *   'booking-456',
   *   { holdDurationSeconds: 900 } // 15 minutes
   * );
   *
   * if (result.success) {
   *   console.log(`Reserved ${result.reserved} seats until ${result.expires_at}`);
   * } else {
   *   console.log(`Failed: ${result.message}`, result.unavailable);
   * }
   * ```
   */
  async reserveSeats(
    showtimeId: string,
    seats: SeatInfo[],
    bookingId: string,
    options: ReserveSeatOptions = {},
  ): Promise<SeatReservationResult> {
    const { holdDurationSeconds = DEFAULT_HOLD_DURATION_SECONDS } = options;

    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);
    const availableKey = REDIS_KEY_PATTERNS.AVAILABLE(showtimeId);
    const holdExpire = Math.floor(Date.now() / 1000) + holdDurationSeconds;

    // Format: "seatId:seatType"
    const seatArgs = seats.map((s) => `${s.seatId}:${s.seatType}`);

    try {
      const startTime = Date.now();

      const result = await this.executeScript<SeatReservationResult>(
        'batchReserve',
        [seatsKey, availableKey],
        [bookingId, holdExpire, seats.length, ...seatArgs],
      );

      const duration = Date.now() - startTime;
      this.logger.debug(
        `reserveSeats completed in ${duration}ms - showtimeId: ${showtimeId}, bookingId: ${bookingId}, success: ${result.success}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `reserveSeats failed - showtimeId: ${showtimeId}, bookingId: ${bookingId}, error: ${error instanceof Error ? error.message : 'Unknown'}`,
      );
      return {
        success: false,
        message: 'INTERNAL_ERROR',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Confirm seats after successful payment.
   *
   * Converts held seats to permanently booked status.
   * Only confirms seats that belong to the specified booking.
   *
   * @param showtimeId - The showtime identifier
   * @param bookingId - The booking identifier that holds the seats
   * @param seatIds - Array of seat IDs to confirm
   * @returns Confirmation result
   */
  async confirmSeats(
    showtimeId: string,
    bookingId: string,
    seatIds: string[],
  ): Promise<SeatConfirmationResult> {
    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);

    try {
      const result = await this.executeScript<SeatConfirmationResult>(
        'confirmSeats',
        [seatsKey],
        [bookingId, ...seatIds],
      );

      this.logger.debug(
        `confirmSeats - showtimeId: ${showtimeId}, bookingId: ${bookingId}, confirmed: ${result.confirmed}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `confirmSeats failed - showtimeId: ${showtimeId}, bookingId: ${bookingId}, error: ${error instanceof Error ? error.message : 'Unknown'}`,
      );
      return {
        success: false,
        message: 'INTERNAL_ERROR',
        confirmed: 0,
        failed: seatIds.map((id) => ({ id, reason: 'NOT_FOUND' as const })),
        booking_id: bookingId,
      };
    }
  }

  /**
   * Release seats back to available status.
   *
   * Used when:
   * - Booking is cancelled
   * - Payment fails
   * - User abandons checkout
   *
   * @param showtimeId - The showtime identifier
   * @param bookingId - The booking identifier
   * @param seatIds - Array of seat IDs to release
   * @returns Release result
   */
  async releaseSeats(
    showtimeId: string,
    bookingId: string,
    seatIds: string[],
  ): Promise<SeatReleaseResult> {
    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);
    const availableKey = REDIS_KEY_PATTERNS.AVAILABLE(showtimeId);

    try {
      const result = await this.executeScript<SeatReleaseResult>(
        'releaseSeats',
        [seatsKey, availableKey],
        [bookingId, ...seatIds],
      );

      this.logger.debug(
        `releaseSeats - showtimeId: ${showtimeId}, bookingId: ${bookingId}, released: ${result.released}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `releaseSeats failed - showtimeId: ${showtimeId}, bookingId: ${bookingId}, error: ${error instanceof Error ? error.message : 'Unknown'}`,
      );
      return {
        success: false,
        message: 'INTERNAL_ERROR',
        released: 0,
        failed: seatIds.map((id) => ({ id, reason: 'NOT_FOUND' as const })),
        booking_id: bookingId,
      };
    }
  }

  /**
   * Get available seat count (O(1) operation).
   *
   * @param showtimeId - The showtime identifier
   * @returns Number of available seats
   */
  async getAvailableCount(showtimeId: string): Promise<number> {
    const availableKey = REDIS_KEY_PATTERNS.AVAILABLE(showtimeId);
    const count = await this.redisService.get(availableKey);
    return count ? parseInt(count, 10) : 0;
  }

  /**
   * Get status of specific seats or all seats for a showtime.
   *
   * Also performs lazy cleanup of expired holds during read.
   *
   * @param showtimeId - The showtime identifier
   * @param seatIds - Optional array of specific seat IDs (empty for all)
   * @returns Seats status with availability info
   */
  async getSeatsStatus(
    showtimeId: string,
    seatIds: string[] = [],
  ): Promise<SeatsStatusResult> {
    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);
    const availableKey = REDIS_KEY_PATTERNS.AVAILABLE(showtimeId);

    try {
      const result = await this.executeScript<SeatsStatusResult>(
        'getSeatsStatus',
        [seatsKey, availableKey],
        seatIds,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `getSeatsStatus failed - showtimeId: ${showtimeId}, error: ${error instanceof Error ? error.message : 'Unknown'}`,
      );
      return {
        success: false,
        seats: {},
        available_count: 0,
        total_seats: 0,
        expired_cleaned: 0,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
  }

  /**
   * Initialize showtime seats in Redis.
   *
   * Called when a showtime is created or when syncing from MongoDB.
   * Uses pipelining for efficient bulk operations.
   *
   * @param showtimeId - The showtime identifier
   * @param seats - Array of all seats for the showtime
   * @param options - Initialization options
   */
  async initializeShowtime(
    showtimeId: string,
    seats: SeatInfo[],
    options: InitializeShowtimeOptions = {},
  ): Promise<void> {
    const { ttlSeconds = DEFAULT_SHOWTIME_TTL_SECONDS, overwrite = false } = options;

    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);
    const availableKey = REDIS_KEY_PATTERNS.AVAILABLE(showtimeId);

    // Check if already exists
    if (!overwrite) {
      const exists = await this.redisService.exists(seatsKey);
      if (exists) {
        this.logger.warn(`Showtime ${showtimeId} already initialized, skipping`);
        return;
      }
    }

    const pipeline = this.redisService.pipeline();

    // Clear existing data if overwriting
    if (overwrite) {
      pipeline.del(seatsKey);
      pipeline.del(availableKey);
    }

    // Set each seat as available
    for (const seat of seats) {
      const seatData = JSON.stringify({
        status: 'available',
        seat_type: seat.seatType,
      });
      pipeline.hset(seatsKey, seat.seatId, seatData);
    }

    // Set available counter
    pipeline.set(availableKey, seats.length.toString());

    // Set TTL for automatic cleanup
    pipeline.expire(seatsKey, ttlSeconds);
    pipeline.expire(availableKey, ttlSeconds);

    await pipeline.exec();

    this.logger.log(
      `Initialized ${seats.length} seats for showtime ${showtimeId} (TTL: ${ttlSeconds}s)`,
    );
  }

  /**
   * Cleanup expired holds for a showtime.
   *
   * Should be called periodically by a cron job to release orphaned holds.
   *
   * @param showtimeId - The showtime identifier
   * @returns Cleanup result with number of released seats
   */
  async cleanupExpiredHolds(showtimeId: string): Promise<CleanupResult> {
    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);
    const availableKey = REDIS_KEY_PATTERNS.AVAILABLE(showtimeId);

    try {
      const result = await this.executeScript<CleanupResult>(
        'cleanupExpiredHolds',
        [seatsKey, availableKey],
        [],
      );

      if (result.released > 0) {
        this.logger.log(
          `Cleaned up ${result.released} expired holds for showtime ${showtimeId}`,
        );
      }

      return result;
    } catch (error) {
      this.logger.error(
        `cleanupExpiredHolds failed - showtimeId: ${showtimeId}, error: ${error instanceof Error ? error.message : 'Unknown'}`,
      );
      return {
        success: false,
        message: 'INTERNAL_ERROR',
        released: 0,
        seats: [],
        cleanup_time: Math.floor(Date.now() / 1000),
      };
    }
  }

  /**
   * Batch cleanup expired holds for multiple showtimes.
   *
   * Useful for cron jobs that need to clean up all active showtimes.
   *
   * @param showtimeIds - Array of showtime identifiers
   * @returns Map of showtime ID to cleanup result
   */
  async batchCleanupExpiredHolds(
    showtimeIds: string[],
  ): Promise<Map<string, CleanupResult>> {
    const results = new Map<string, CleanupResult>();

    // Process in parallel with concurrency limit
    const BATCH_SIZE = 10;
    for (let i = 0; i < showtimeIds.length; i += BATCH_SIZE) {
      const batch = showtimeIds.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((id) => this.cleanupExpiredHolds(id)),
      );

      batch.forEach((id, index) => {
        results.set(id, batchResults[index]);
      });
    }

    return results;
  }

  /**
   * Check if a showtime is initialized in Redis.
   *
   * @param showtimeId - The showtime identifier
   * @returns True if initialized
   */
  async isShowtimeInitialized(showtimeId: string): Promise<boolean> {
    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);
    return this.redisService.exists(seatsKey);
  }

  /**
   * Delete showtime data from Redis.
   *
   * Used when a showtime is cancelled or completed.
   *
   * @param showtimeId - The showtime identifier
   * @returns Number of keys deleted
   */
  async deleteShowtime(showtimeId: string): Promise<number> {
    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);
    const availableKey = REDIS_KEY_PATTERNS.AVAILABLE(showtimeId);

    const deleted = await this.redisService.delMany([seatsKey, availableKey]);
    this.logger.log(`Deleted showtime ${showtimeId} data (${deleted} keys)`);

    return deleted;
  }

  /**
   * Extend hold duration for a booking.
   *
   * Useful when user needs more time during checkout.
   *
   * @param showtimeId - The showtime identifier
   * @param bookingId - The booking identifier
   * @param seatIds - Array of seat IDs
   * @param additionalSeconds - Additional seconds to add to hold
   * @returns Number of seats with extended hold
   */
  async extendHold(
    showtimeId: string,
    bookingId: string,
    seatIds: string[],
    additionalSeconds: number,
  ): Promise<number> {
    const seatsKey = REDIS_KEY_PATTERNS.SEATS(showtimeId);

    // Inline script for extending hold
    const extendScript = `
      local booking_id = ARGV[1]
      local additional = tonumber(ARGV[2])
      local extended = 0
      local now = tonumber(redis.call('TIME')[1])

      for i = 3, #ARGV do
        local current = redis.call('HGET', KEYS[1], ARGV[i])
        if current then
          local data = cjson.decode(current)
          if data.booking_id == booking_id and data.status == 'held' then
            local held_until = tonumber(data.held_until) or now
            if held_until > now then
              data.held_until = held_until + additional
              redis.call('HSET', KEYS[1], ARGV[i], cjson.encode(data))
              extended = extended + 1
            end
          end
        end
      end
      return extended
    `;

    try {
      const result = await this.redisService.eval(
        extendScript,
        [seatsKey],
        [bookingId, additionalSeconds, ...seatIds],
      );

      this.logger.debug(
        `extendHold - showtimeId: ${showtimeId}, bookingId: ${bookingId}, extended: ${result}`,
      );

      return result as number;
    } catch (error) {
      this.logger.error(
        `extendHold failed - showtimeId: ${showtimeId}, error: ${error instanceof Error ? error.message : 'Unknown'}`,
      );
      return 0;
    }
  }

  /**
   * Get Redis key patterns for external use (e.g., pub/sub).
   */
  getKeyPatterns(): typeof REDIS_KEY_PATTERNS {
    return REDIS_KEY_PATTERNS;
  }
}
