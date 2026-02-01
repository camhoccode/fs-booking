import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Payment status enum
 * - pending: Payment initiated but not yet processed
 * - processing: Payment is being processed by gateway
 * - completed: Payment successful
 * - failed: Payment failed
 * - refunded: Payment was refunded
 */
export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

/**
 * Payment method enum
 */
export enum PaymentMethod {
  CREDIT_CARD = 'credit_card',
  DEBIT_CARD = 'debit_card',
  BANK_TRANSFER = 'bank_transfer',
  E_WALLET = 'e_wallet',
  MOMO = 'momo',
  VNPAY = 'vnpay',
  ZALOPAY = 'zalopay',
}

/**
 * Currency enum
 */
export enum Currency {
  VND = 'VND',
  USD = 'USD',
}

/**
 * Gateway response storage
 */
@Schema({ _id: false })
export class GatewayResponse {
  @Prop({
    required: false,
    type: String,
    maxlength: 50,
    comment: 'Response code from payment gateway',
  })
  code?: string;

  @Prop({
    required: false,
    type: String,
    maxlength: 500,
    comment: 'Response message from payment gateway',
  })
  message?: string;

  @Prop({
    required: false,
    type: Object,
    comment: 'Raw response data from payment gateway',
  })
  raw_data?: Record<string, unknown>;

  @Prop({
    required: false,
    type: Date,
    comment: 'When the response was received',
  })
  received_at?: Date;
}

export const GatewayResponseSchema =
  SchemaFactory.createForClass(GatewayResponse);

export type PaymentDocument = HydratedDocument<Payment>;

@Schema({
  timestamps: true,
  collection: 'payments',
  toJSON: {
    virtuals: true,
    transform: function (_, ret) {
      const obj = ret as Record<string, unknown>;
      obj.id = obj._id;
      delete obj._id;
      delete obj.__v;
      // Remove sensitive gateway data from JSON output
      const gatewayResponse = obj.gateway_response as Record<string, unknown> | undefined;
      if (gatewayResponse?.raw_data) {
        delete gatewayResponse.raw_data;
      }
      return ret;
    },
  },
})
export class Payment {
  @Prop({
    required: true,
    type: Types.ObjectId,
    ref: 'Booking',
    index: true,
  })
  booking_id: Types.ObjectId;

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
    unique: true,
    index: true,
    maxlength: 100,
    comment: 'Idempotency key to prevent duplicate payments',
  })
  idempotency_key: string;

  @Prop({
    required: true,
    min: 0,
    comment: 'Payment amount in smallest currency unit',
  })
  amount: number;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(Currency),
    default: Currency.VND,
  })
  currency: Currency;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(PaymentMethod),
  })
  payment_method: PaymentMethod;

  @Prop({
    required: false,
    type: String,
    index: true,
    sparse: true,
    maxlength: 255,
    comment: 'Transaction ID from payment gateway',
  })
  gateway_transaction_id?: string;

  @Prop({
    required: false,
    type: GatewayResponseSchema,
    comment: 'Response data from payment gateway',
  })
  gateway_response?: GatewayResponse;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.PENDING,
    index: true,
  })
  status: PaymentStatus;

  @Prop({
    required: true,
    type: Number,
    default: 0,
    min: 0,
    max: 10,
    comment: 'Number of payment attempts',
  })
  attempt_count: number;

  @Prop({
    required: false,
    type: Date,
    comment: 'Timestamp of the last payment attempt',
  })
  last_attempt_at?: Date;

  @Prop({
    required: false,
    type: Date,
    comment: 'When the payment was completed successfully',
  })
  completed_at?: Date;

  @Prop({
    required: false,
    type: Date,
    comment: 'When the payment failed',
  })
  failed_at?: Date;

  @Prop({
    required: false,
    type: String,
    maxlength: 500,
    comment: 'Reason for payment failure',
  })
  failure_reason?: string;

  @Prop({
    required: false,
    type: Date,
    comment: 'When the payment was refunded',
  })
  refunded_at?: Date;

  @Prop({
    required: false,
    type: Number,
    min: 0,
    comment: 'Refunded amount (can be partial)',
  })
  refunded_amount?: number;

  @Prop({
    required: false,
    type: String,
    maxlength: 500,
    comment: 'Reason for refund',
  })
  refund_reason?: string;

  @Prop({
    required: false,
    type: String,
    maxlength: 50,
    comment: 'IP address of the payer for fraud detection',
  })
  payer_ip?: string;

  @Prop({
    required: false,
    type: String,
    maxlength: 500,
    comment: 'User agent of the payer for fraud detection',
  })
  payer_user_agent?: string;

  @Prop({
    required: false,
    type: String,
    maxlength: 2048,
    comment: 'Payment URL from gateway',
  })
  payment_url?: string;

  @Prop({
    required: false,
    type: String,
    maxlength: 2048,
    comment: 'Return URL after payment',
  })
  return_url?: string;

  @Prop({
    required: false,
    type: Date,
    comment: 'When the payment expires',
  })
  expires_at?: Date;

  @Prop({
    required: false,
    type: Date,
    comment: 'When the payment was actually paid',
  })
  paid_at?: Date;

  @Prop({
    required: false,
    type: Object,
    comment: 'Additional metadata',
  })
  metadata?: Record<string, unknown>;

  @Prop({
    required: false,
    type: Number,
    default: 0,
    comment: 'Version for optimistic locking',
  })
  version?: number;

  // Virtual fields from timestamps
  createdAt: Date;
  updatedAt: Date;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

// Compound indexes for common query patterns
PaymentSchema.index({ user_id: 1, status: 1 });
PaymentSchema.index({ user_id: 1, createdAt: -1 });
PaymentSchema.index({ booking_id: 1, status: 1 });
PaymentSchema.index({ status: 1, createdAt: -1 });

// Index for finding payments by gateway transaction
PaymentSchema.index({ gateway_transaction_id: 1, payment_method: 1 });

// Index for payment reconciliation
PaymentSchema.index({ status: 1, completed_at: -1 });

// Index for failed payment retry logic
PaymentSchema.index(
  { status: 1, attempt_count: 1, last_attempt_at: 1 },
  {
    partialFilterExpression: {
      status: { $in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
    },
  },
);

// Index for refund tracking
PaymentSchema.index(
  { status: 1, refunded_at: -1 },
  {
    partialFilterExpression: {
      status: PaymentStatus.REFUNDED,
    },
  },
);
