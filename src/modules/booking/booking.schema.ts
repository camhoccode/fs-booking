import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { SeatType } from '../showtime/showtime.schema';

/**
 * Booking status enum
 * - pending: Seats are held, waiting for payment
 * - confirmed: Payment completed, booking confirmed
 * - cancelled: Booking was cancelled by user or system
 * - expired: Hold time expired without payment
 */
export enum BookingStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

/**
 * Individual seat information in a booking
 */
@Schema({ _id: false })
export class BookedSeat {
  @Prop({
    required: true,
    type: String,
    comment: 'Seat identifier (e.g., "A1", "B5")',
  })
  seat_id: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(SeatType),
    default: SeatType.STANDARD,
  })
  seat_type: SeatType;

  @Prop({
    required: true,
    min: 0,
    comment: 'Price for this specific seat',
  })
  price: number;
}

export const BookedSeatSchema = SchemaFactory.createForClass(BookedSeat);

export type BookingDocument = HydratedDocument<Booking>;

@Schema({
  timestamps: true,
  collection: 'bookings',
  toJSON: {
    virtuals: true,
    transform: function (_, ret) {
      (ret as Record<string, unknown>).id = ret._id;
      delete (ret as Record<string, unknown>)._id;
      delete (ret as Record<string, unknown>).__v;
      return ret;
    },
  },
})
export class Booking {
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
    uppercase: true,
    maxlength: 20,
    comment: 'Human-readable booking code (e.g., "BK-ABC12345")',
  })
  booking_code: string;

  @Prop({
    required: true,
    type: Types.ObjectId,
    ref: 'User',
    index: true,
  })
  user_id: Types.ObjectId;

  @Prop({
    required: true,
    type: Types.ObjectId,
    ref: 'Showtime',
    index: true,
  })
  showtime_id: Types.ObjectId;

  @Prop({
    type: [BookedSeatSchema],
    required: true,
    validate: {
      validator: (seats: BookedSeat[]) => seats.length > 0 && seats.length <= 10,
      message: 'Booking must have between 1 and 10 seats',
    },
  })
  seats: BookedSeat[];

  @Prop({
    required: true,
    min: 0,
    comment: 'Sum of all seat prices before discount',
  })
  total_amount: number;

  @Prop({
    required: true,
    min: 0,
    default: 0,
    comment: 'Discount amount applied',
  })
  discount_amount: number;

  @Prop({
    required: true,
    min: 0,
    comment: 'Final amount to be paid (total_amount - discount_amount)',
  })
  final_amount: number;

  @Prop({
    required: true,
    type: String,
    default: 'VND',
    maxlength: 10,
    comment: 'Currency code (e.g., VND, USD)',
  })
  currency: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BookingStatus),
    default: BookingStatus.PENDING,
    index: true,
  })
  status: BookingStatus;

  @Prop({
    required: true,
    type: Date,
    index: true,
    comment: 'When the seats were held',
  })
  held_at: Date;

  @Prop({
    required: true,
    type: Date,
    index: true,
    comment: 'When the hold expires if not paid',
  })
  hold_expires_at: Date;

  @Prop({
    required: false,
    type: Date,
    comment: 'When the booking was confirmed (payment completed)',
  })
  confirmed_at?: Date;

  @Prop({
    required: false,
    type: Date,
    comment: 'When the booking was cancelled',
  })
  cancelled_at?: Date;

  @Prop({
    required: false,
    type: String,
    maxlength: 500,
    comment: 'Reason for cancellation if applicable',
  })
  cancellation_reason?: string;

  @Prop({
    required: false,
    type: Types.ObjectId,
    ref: 'Payment',
    index: true,
  })
  payment_id?: Types.ObjectId;

  @Prop({
    required: true,
    type: String,
    unique: true,
    index: true,
    comment: 'Idempotency key to prevent duplicate bookings',
  })
  idempotency_key: string;

  @Prop({
    required: false,
    type: String,
    maxlength: 100,
    comment: 'Promo/coupon code applied',
  })
  promo_code?: string;

  // Virtual fields from timestamps
  createdAt: Date;
  updatedAt: Date;
}

export const BookingSchema = SchemaFactory.createForClass(Booking);

// Compound indexes for common query patterns
BookingSchema.index({ user_id: 1, status: 1 });
BookingSchema.index({ user_id: 1, createdAt: -1 });
BookingSchema.index({ showtime_id: 1, status: 1 });
BookingSchema.index({ status: 1, hold_expires_at: 1 });

// Index for finding expired pending bookings (for cleanup job)
BookingSchema.index(
  { status: 1, hold_expires_at: 1 },
  {
    partialFilterExpression: {
      status: BookingStatus.PENDING,
    },
  },
);

// Index for user booking history with date range
BookingSchema.index({ user_id: 1, confirmed_at: -1 });
