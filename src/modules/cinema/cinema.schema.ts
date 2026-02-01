import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Screen type enum
 * - standard: Regular 2D screen
 * - imax: IMAX format
 * - 3d: 3D capable screen
 * - 4dx: 4DX experience
 * - vip: VIP/Premium screen
 */
export enum ScreenType {
  STANDARD = 'standard',
  IMAX = 'imax',
  THREE_D = '3d',
  FOUR_DX = '4dx',
  VIP = 'vip',
}

/**
 * Seat layout configuration
 * Defines the physical arrangement of seats in a screen
 */
@Schema({ _id: false })
export class SeatLayout {
  @Prop({
    required: true,
    min: 1,
    max: 50,
    comment: 'Number of rows (A, B, C...)',
  })
  rows: number;

  @Prop({
    required: true,
    min: 1,
    max: 50,
    comment: 'Number of columns (seats per row)',
  })
  cols: number;

  @Prop({
    type: [String],
    default: [],
    comment: 'List of unavailable seat IDs (e.g., ["A1", "A2", "B5"])',
  })
  unavailable: string[];
}

export const SeatLayoutSchema = SchemaFactory.createForClass(SeatLayout);

/**
 * Screen configuration within a cinema
 */
@Schema({ _id: false })
export class Screen {
  @Prop({
    required: true,
    type: String,
    comment: 'Unique identifier for the screen within the cinema',
  })
  screen_id: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 100,
    comment: 'Display name (e.g., "Screen 1", "IMAX Hall")',
  })
  name: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(ScreenType),
    default: ScreenType.STANDARD,
  })
  type: ScreenType;

  @Prop({
    required: true,
    min: 1,
    max: 1000,
    comment: 'Total number of available seats',
  })
  total_seats: number;

  @Prop({
    required: true,
    type: SeatLayoutSchema,
  })
  seat_layout: SeatLayout;
}

export const ScreenSchema = SchemaFactory.createForClass(Screen);

export type CinemaDocument = HydratedDocument<Cinema>;

@Schema({
  timestamps: true,
  collection: 'cinemas',
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
export class Cinema {
  @Prop({
    required: true,
    trim: true,
    maxlength: 255,
    index: true,
  })
  name: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 500,
  })
  address: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 100,
    index: true,
  })
  city: string;

  @Prop({
    type: [ScreenSchema],
    default: [],
    validate: {
      validator: function (screens: Screen[]) {
        // Validate unique screen_id within the cinema
        const screenIds = screens.map((s) => s.screen_id);
        return new Set(screenIds).size === screenIds.length;
      },
      message: 'Screen IDs must be unique within a cinema',
    },
  })
  screens: Screen[];

  @Prop({
    required: false,
    trim: true,
    maxlength: 20,
    comment: 'Contact phone number',
  })
  phone: string;

  @Prop({
    required: false,
    type: Boolean,
    default: true,
    index: true,
    comment: 'Whether the cinema is currently active',
  })
  is_active: boolean;

  // Virtual fields from timestamps
  createdAt: Date;
  updatedAt: Date;
}

export const CinemaSchema = SchemaFactory.createForClass(Cinema);

// Compound indexes for common query patterns
CinemaSchema.index({ city: 1, is_active: 1 });
CinemaSchema.index({ name: 'text', address: 'text' }); // Text search index
CinemaSchema.index({ 'screens.screen_id': 1 }); // For querying specific screens
