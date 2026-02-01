/**
 * Redis constants for lock key patterns and configuration
 */

// Lock key patterns
export const LOCK_BOOKING_SHOWTIME = 'lock:booking:showtime:';
export const HELD_SEATS_EXPIRY = 'held_seats:expiry';
export const RATE_LIMIT_BOOKING = 'ratelimit:booking:';

// Seat reservation key patterns
export const SHOWTIME_SEATS_KEY = 'showtime:{showtimeId}:seats';
export const SHOWTIME_AVAILABLE_KEY = 'showtime:{showtimeId}:available';

// Seat reservation configuration
export const DEFAULT_HOLD_DURATION_SECONDS = 600; // 10 minutes
export const DEFAULT_SHOWTIME_TTL_SECONDS = 86400 * 7; // 7 days
export const CLEANUP_BATCH_SIZE = 10;

// Lock configuration defaults
export const DEFAULT_LOCK_TTL = 5000; // milliseconds
export const DEFAULT_MAX_RETRY = 3;
export const DEFAULT_RETRY_DELAY = 100; // milliseconds

// Redis injection token
export const REDIS_CLIENT = 'REDIS_CLIENT';

// Lua scripts for atomic operations
export const LUA_SCRIPTS = {
  /**
   * Acquire lock script
   * KEYS[1]: lock key
   * ARGV[1]: lock value (owner identifier)
   * ARGV[2]: TTL in milliseconds
   * Returns: "OK" if acquired, null if not
   */
  ACQUIRE_LOCK: `
    return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
  `,

  /**
   * Release lock script
   * KEYS[1]: lock key
   * ARGV[1]: lock value (owner identifier)
   * Returns: 1 if released, 0 if not owner or key doesn't exist
   */
  RELEASE_LOCK: `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `,

  /**
   * Extend lock script
   * KEYS[1]: lock key
   * ARGV[1]: lock value (owner identifier)
   * ARGV[2]: new TTL in milliseconds
   * Returns: 1 if extended, 0 if not owner or key doesn't exist
   */
  EXTEND_LOCK: `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('PEXPIRE', KEYS[1], ARGV[2])
    else
      return 0
    end
  `,
} as const;
