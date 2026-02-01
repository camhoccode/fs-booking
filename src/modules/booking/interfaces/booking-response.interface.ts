import { BookingStatus } from '../booking.schema';

/**
 * Response interface for hold seats operation
 */
export interface HoldSeatsResponse {
  booking_id: string;
  booking_code: string;
  showtime_id: string;
  seats: string[];
  total_amount: number;
  final_amount: number;
  currency: string;
  status: BookingStatus;
  held_at: Date;
  hold_expires_at: Date;
  created_at: Date;
}

/**
 * Response interface for confirm booking operation
 */
export interface ConfirmBookingResponse {
  booking_id: string;
  booking_code: string;
  payment_id: string;
  payment_url: string;
  expires_at: Date;
}

/**
 * Response interface for booking details
 */
export interface BookingDetailsResponse {
  id: string;
  booking_code: string;
  showtime_id: string;
  user_id: string;
  seats: Array<{
    seat_id: string;
    seat_type: string;
    price: number;
  }>;
  total_amount: number;
  discount_amount: number;
  final_amount: number;
  currency: string;
  status: BookingStatus;
  held_at: Date;
  hold_expires_at: Date;
  payment_id?: string;
  promo_code?: string;
  confirmed_at?: Date;
  cancelled_at?: Date;
  cancellation_reason?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Response interface for cancel booking operation
 */
export interface CancelBookingResponse {
  booking_id: string;
  booking_code: string;
  status: BookingStatus;
  cancelled_at: Date;
  seats_released: string[];
}
