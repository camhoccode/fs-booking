import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Showtime status enum
 * - scheduled: Showtime is scheduled and accepting bookings
 * - cancelled: Showtime has been cancelled
 * - completed: Showtime has ended
 */
export enum ShowtimeStatus {
  SCHEDULED = 'scheduled',
  CANCELLED = 'cancelled',
  COMPLETED = 'completed',
}

/**
 * Seat status enum
 * - available: Seat can be booked
 * - held: Seat is temporarily held during booking process
 * - booked: Seat has been confirmed and paid
 */
export enum SeatStatus {
  AVAILABLE = 'available',
  HELD = 'held',
  BOOKED = 'booked',
}

/**
 * Seat type enum for pricing
 */
export enum SeatType {
  STANDARD = 'standard',
  VIP = 'vip',
  COUPLE = 'couple',
}

/**
 * Price configuration for different seat types
 */
@Schema({ _id: false })
export class ShowtimePrice {
  @Prop({
    required: true,
    min: 0,
    comment: 'Standard seat price in smallest currency unit (e.g., cents, VND)',
  })
  standard: number;

  @Prop({
    required: true,
    min: 0,
    comment: 'VIP seat price',
  })
  vip: number;

  @Prop({
    required: true,
    min: 0,
    comment: 'Couple seat price (for 2 people)',
  })
  couple: number;
}

export const ShowtimePriceSchema = SchemaFactory.createForClass(ShowtimePrice);

/**
 * Individual seat status and booking information
 */
@Schema({ _id: false })
export class SeatInfo {
  @Prop({
    required: true,
    type: String,
    enum: Object.values(SeatStatus),
    default: SeatStatus.AVAILABLE,
  })
  status: SeatStatus;

  @Prop({
    required: false,
    type: Date,
    comment: 'Expiration time for held seats',
  })
  held_until?: Date;

  @Prop({
    required: false,
    type: Types.ObjectId,
    ref: 'Booking',
    comment: 'Reference to the booking that holds/booked this seat',
  })
  booking_id?: Types.ObjectId;

  @Prop({
    required: false,
    type: String,
    enum: Object.values(SeatType),
    default: SeatType.STANDARD,
    comment: 'Type of seat for pricing purposes',
  })
  seat_type?: SeatType;
}

export const SeatInfoSchema = SchemaFactory.createForClass(SeatInfo);

export type ShowtimeDocument = HydratedDocument<Showtime>;

@Schema({
  timestamps: true,
  collection: 'showtimes',
  toJSON: {
    virtuals: true,
    transform: function (_, ret) {
      (ret as Record<string, unknown>).id = ret._id;
      delete (ret as Record<string, unknown>)._id;
      delete (ret as Record<string, unknown>).__v;
      return ret;
    },
  },
  // Enable optimistic concurrency control
  optimisticConcurrency: true,
})
export class Showtime {
  @Prop({
    required: true,
    type: Types.ObjectId,
    ref: 'Movie',
    index: true,
  })
  movie_id: Types.ObjectId;

  @Prop({
    required: true,
    type: Types.ObjectId,
    ref: 'Cinema',
    index: true,
  })
  cinema_id: Types.ObjectId;

  @Prop({
    required: true,
    type: String,
    comment: 'Screen ID within the cinema',
  })
  screen_id: string;

  @Prop({
    required: true,
    type: Date,
    index: true,
  })
  start_time: Date;

  @Prop({
    required: true,
    type: Date,
    index: true,
  })
  end_time: Date;

  @Prop({
    required: true,
    type: ShowtimePriceSchema,
  })
  price: ShowtimePrice;

  @Prop({
    required: true,
    min: 1,
    comment: 'Total number of seats in the screen',
  })
  total_seats: number;

  @Prop({
    required: true,
    min: 0,
    comment: 'Number of currently available seats',
  })
  available_seats: number;

  @Prop({
    type: Map,
    of: SeatInfoSchema,
    default: new Map(),
    comment: 'Map of seat_id to seat status information',
  })
  seats: Map<string, SeatInfo>;

  @Prop({
    required: true,
    type: Number,
    default: 0,
    min: 0,
    comment: 'Version number for optimistic locking',
  })
  version: number;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(ShowtimeStatus),
    default: ShowtimeStatus.SCHEDULED,
    index: true,
  })
  status: ShowtimeStatus;

  // Virtual fields from timestamps
  createdAt: Date;
  updatedAt: Date;
}

export const ShowtimeSchema = SchemaFactory.createForClass(Showtime);

// Compound indexes for common query patterns
ShowtimeSchema.index({ movie_id: 1, start_time: 1 });
ShowtimeSchema.index({ cinema_id: 1, start_time: 1 });
ShowtimeSchema.index({ cinema_id: 1, screen_id: 1, start_time: 1 });
ShowtimeSchema.index({ start_time: 1, status: 1 });
ShowtimeSchema.index({ status: 1, start_time: 1, available_seats: 1 });

// Index for finding showtimes with available seats
ShowtimeSchema.index(
  { movie_id: 1, status: 1, start_time: 1, available_seats: 1 },
  { partialFilterExpression: { available_seats: { $gt: 0 } } },
);

// TTL index to auto-cleanup old completed showtimes (optional, commented out)
// ShowtimeSchema.index({ end_time: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30 days
