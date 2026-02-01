/**
 * Seat status enum
 */
export enum SeatStatus {
  AVAILABLE = 'available',
  HELD = 'held',
  BOOKED = 'booked',
}

/**
 * Seat type enum for different pricing tiers
 */
export enum SeatType {
  STANDARD = 'standard',
  VIP = 'vip',
  COUPLE = 'couple',
  PREMIUM = 'premium',
}

/**
 * Seat information for reservation
 */
export interface SeatInfo {
  seatId: string;
  seatType: SeatType | string;
}

/**
 * Seat status data stored in Redis
 */
export interface SeatStatusData {
  status: SeatStatus;
  seat_type: string;
  booking_id?: string;
  held_until?: number;
  reserved_at?: number;
  confirmed_at?: number;
  released_at?: number;
  released_reason?: string;
  previous_booking?: string;
  remaining_seconds?: number;
}

/**
 * Result of seat reservation operation
 */
export interface SeatReservationResult {
  success: boolean;
  message: string;
  reserved?: number;
  booking_id?: string;
  expires_at?: number;
  unavailable?: UnavailableSeat[];
  error?: string;
}

/**
 * Information about unavailable seat
 */
export interface UnavailableSeat {
  id: string;
  reason: 'BOOKED' | 'HELD' | 'NOT_FOUND';
  held_by?: string;
}

/**
 * Result of seat confirmation operation
 */
export interface SeatConfirmationResult {
  success: boolean;
  message: string;
  confirmed: number;
  failed: FailedSeat[];
  booking_id: string;
}

/**
 * Result of seat release operation
 */
export interface SeatReleaseResult {
  success: boolean;
  message: string;
  released: number;
  failed: FailedSeat[];
  booking_id: string;
}

/**
 * Information about failed seat operation
 */
export interface FailedSeat {
  id: string;
  reason: 'NOT_FOUND' | 'NOT_HELD' | 'WRONG_BOOKING' | 'HOLD_EXPIRED';
  current_status?: string;
  held_by?: string;
}

/**
 * Result of cleanup operation
 */
export interface CleanupResult {
  success: boolean;
  message: string;
  released: number;
  seats: ExpiredSeat[];
  cleanup_time: number;
}

/**
 * Information about expired seat that was cleaned up
 */
export interface ExpiredSeat {
  id: string;
  previous_booking: string;
  expired_at: number;
}

/**
 * Result of get seats status operation
 */
export interface SeatsStatusResult {
  success: boolean;
  seats: Record<string, SeatStatusData | null>;
  available_count: number;
  total_seats: number;
  expired_cleaned: number;
  timestamp: number;
}

/**
 * Options for initializing showtime seats
 */
export interface InitializeShowtimeOptions {
  /** TTL in seconds for the seat data (default: 7 days) */
  ttlSeconds?: number;
  /** Whether to overwrite existing data (default: false) */
  overwrite?: boolean;
}

/**
 * Options for seat reservation
 */
export interface ReserveSeatOptions {
  /** Duration to hold the seat in seconds (default: 600 = 10 minutes) */
  holdDurationSeconds?: number;
}

/**
 * Lua script SHA cache for performance
 */
export interface LuaScriptShaCache {
  batchReserve: string;
  confirmSeats: string;
  releaseSeats: string;
  cleanupExpiredHolds: string;
  getSeatsStatus: string;
  singleReserve: string;
}

/**
 * Metrics for monitoring
 */
export interface SeatReservationMetrics {
  reservations_total: number;
  reservations_success: number;
  reservations_failed: number;
  confirmations_total: number;
  releases_total: number;
  cleanups_total: number;
  avg_reservation_time_ms: number;
}
