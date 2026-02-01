import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Resource type enum for idempotency tracking
 */
export type ResourceType = 'payment' | 'booking' | 'refund';

/**
 * Idempotency key status enum
 */
export enum IdempotencyKeyStatus {
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export type IdempotencyKeyDocument = HydratedDocument<IdempotencyKey>;

@Schema({
  timestamps: true,
  collection: 'idempotency_keys',
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
export class IdempotencyKey {
  @Prop({
    required: true,
    type: String,
    maxlength: 100,
    index: true,
  })
  key: string;

  @Prop({
    required: true,
    type: Types.ObjectId,
    ref: 'User',
    index: true,
  })
  user_id: Types.ObjectId;

  @Prop({
    required: true,
    type: String,
    maxlength: 255,
    comment: 'API path that was called',
  })
  request_path: string;

  @Prop({
    required: true,
    type: String,
    maxlength: 64,
    comment: 'SHA256 hash of request body',
  })
  request_hash: string;

  @Prop({
    required: true,
    type: String,
    comment: 'Type of resource being created',
  })
  resource_type: ResourceType;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(IdempotencyKeyStatus),
    default: IdempotencyKeyStatus.PROCESSING,
    index: true,
  })
  status: IdempotencyKeyStatus;

  @Prop({
    required: false,
    type: Number,
    min: 100,
    max: 599,
    comment: 'HTTP status code of the response',
  })
  response_status?: number;

  @Prop({
    required: false,
    type: Object,
    comment: 'Cached response body',
  })
  response_body?: Record<string, unknown>;

  @Prop({
    required: false,
    type: Types.ObjectId,
    comment: 'ID of the resource that was created',
  })
  resource_id?: Types.ObjectId;

  @Prop({
    required: false,
    type: String,
    maxlength: 500,
    comment: 'Error message if request failed',
  })
  error_message?: string;

  @Prop({
    required: true,
    type: Date,
    comment: 'When this idempotency key expires',
  })
  expires_at: Date;

  // Virtual fields from timestamps
  createdAt: Date;
  updatedAt: Date;
}

export const IdempotencyKeySchema =
  SchemaFactory.createForClass(IdempotencyKey);

// Unique compound index for key + user
IdempotencyKeySchema.index({ key: 1, user_id: 1 }, { unique: true });

// TTL index to auto-cleanup expired keys
IdempotencyKeySchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

// Index for finding processing keys
IdempotencyKeySchema.index(
  { status: 1, createdAt: -1 },
  {
    partialFilterExpression: {
      status: IdempotencyKeyStatus.PROCESSING,
    },
  },
);
