import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Movie status enum
 * - coming_soon: Movie is announced but not yet released
 * - now_showing: Movie is currently in theaters
 * - ended: Movie is no longer showing
 */
export enum MovieStatus {
  COMING_SOON = 'coming_soon',
  NOW_SHOWING = 'now_showing',
  ENDED = 'ended',
}

export type MovieDocument = HydratedDocument<Movie>;

@Schema({
  timestamps: true,
  collection: 'movies',
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
export class Movie {
  @Prop({
    required: true,
    trim: true,
    maxlength: 255,
    index: true,
  })
  title: string;

  @Prop({
    required: true,
    min: 1,
    max: 600, // Max 10 hours in minutes
    comment: 'Duration in minutes',
  })
  duration: number;

  @Prop({
    type: [String],
    required: true,
    validate: {
      validator: (genres: string[]) => genres.length > 0,
      message: 'At least one genre is required',
    },
    index: true,
  })
  genre: string[];

  @Prop({
    required: false,
    trim: true,
    maxlength: 2048,
  })
  poster_url: string;

  @Prop({
    required: false,
    trim: true,
    maxlength: 5000,
  })
  description: string;

  @Prop({
    required: true,
    type: Date,
    index: true,
  })
  release_date: Date;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(MovieStatus),
    default: MovieStatus.COMING_SOON,
    index: true,
  })
  status: MovieStatus;

  // Virtual fields from timestamps
  createdAt: Date;
  updatedAt: Date;
}

export const MovieSchema = SchemaFactory.createForClass(Movie);

// Compound indexes for common query patterns
MovieSchema.index({ status: 1, release_date: -1 });
MovieSchema.index({ genre: 1, status: 1 });
MovieSchema.index({ title: 'text', description: 'text' }); // Text search index
