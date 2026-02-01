# Film Booking System - High Concurrency & Consistency

> A robust film ticket booking system built with NestJS, designed to handle high concurrency scenarios while ensuring data consistency. This project demonstrates solutions to classic distributed systems challenges: race conditions, distributed locking, and idempotency.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Technical Challenges](#2-technical-challenges)
3. [Solution Architecture](#3-solution-architecture)
4. [Detailed Solutions](#4-detailed-solutions)
   - [4.1 Two-Layer Locking Strategy](#41-two-layer-locking-strategy)
   - [4.2 Race Condition Prevention Flow](#42-race-condition-prevention-flow)
   - [4.3 Idempotency Implementation](#43-idempotency-implementation)
   - [4.4 Seat Hold & Expiry](#44-seat-hold--expiry)
5. [Database Design](#5-database-design)
6. [Installation & Setup](#6-installation--setup)
7. [API Documentation](#7-api-documentation)
8. [Testing](#8-testing)
9. [Tech Stack](#9-tech-stack)

---

## 1. Introduction

This project addresses the classic "flash sale" problem in ticket booking systems. The core challenge is ensuring that when 1000 users simultaneously attempt to book the last available seat, exactly one user succeeds while the others receive appropriate error responses - with zero overbooking.

### Key Features

- **Race Condition Protection**: Two-layer locking (Redis + MongoDB) prevents overbooking
- **Distributed Lock**: Redis-based distributed lock with Lua scripts for atomic operations
- **Idempotency**: Duplicate request handling ensures payment is only processed once
- **Seat Hold Mechanism**: 10-minute hold with automatic expiry and cleanup
- **Optimistic Concurrency Control**: Version-based updates for fine-grained consistency

---

## 2. Technical Challenges

From `doc.txt`, this system solves three critical problems for mid-level engineering practice:

### Race Condition
> **Problem**: 1000 users clicking "Buy" on the last ticket simultaneously
>
> **Risk**: Overbooking - selling more tickets than available seats

### Distributed Lock
> **Problem**: Multiple application instances competing for the same resource
>
> **Solution**: Redis Lock + Database Lock (Pessimistic/Optimistic) for contention handling

### Idempotency
> **Problem**: User clicks "Pay" twice due to network lag
>
> **Risk**: Charging the user's account twice for the same booking

### Extended Learning
- Database Isolation Levels
- Node.js async patterns to prevent Event Loop blocking

---

## 3. Solution Architecture

```
                                    +------------------+
                                    |   Load Balancer  |
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+        +-----------v---------+        +-----------v---------+
    |   NestJS App #1   |        |   NestJS App #2     |        |   NestJS App #N     |
    +-------------------+        +---------------------+        +---------------------+
              |                              |                              |
              +------------------------------+------------------------------+
                                             |
                        +--------------------+--------------------+
                        |                                         |
              +---------v---------+                     +---------v---------+
              |       Redis       |                     |      MongoDB      |
              |  (Distributed     |                     |  (Primary Data    |
              |   Lock + Cache)   |                     |   + Versioning)   |
              +-------------------+                     +-------------------+
```

---

## 4. Detailed Solutions

### 4.1 Two-Layer Locking Strategy

The system implements a sophisticated two-layer locking mechanism to ensure consistency:

#### Layer 1: Redis Distributed Lock

**Purpose**: Serialize concurrent requests at the application level

| Configuration | Value | Description |
|--------------|-------|-------------|
| Key Pattern | `lock:booking:showtime:{showtimeId}` | Unique lock per showtime |
| TTL | 5-10 seconds | Auto-release on crash |
| Max Retry | 3 attempts | With exponential backoff |
| Retry Delay | 100ms base | Increases exponentially |

**Implementation** (`src/modules/redis/distributed-lock.service.ts`):

```typescript
// Lua script for atomic lock acquisition
const ACQUIRE_LOCK = `
  return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
`;

// Lua script for safe lock release (only owner can release)
const RELEASE_LOCK = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
`;
```

**Key Features**:
- **Atomic Operations**: Lua scripts ensure SET-IF-NOT-EXISTS and CHECK-AND-DELETE are atomic
- **Owner Verification**: Lock value includes UUID + timestamp to verify ownership
- **Exponential Backoff with Jitter**: Prevents thundering herd problem

```typescript
private calculateBackoff(baseDelay: number, attempt: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * exponentialDelay * 0.5;
  return Math.floor(exponentialDelay + jitter);
}
```

#### Layer 2: MongoDB Optimistic Lock

**Purpose**: Final consistency guarantee at the database level

| Configuration | Value | Description |
|--------------|-------|-------------|
| Implementation | Version field | Incremented on each update |
| Max Retry | 3 attempts | On version conflict |
| Conflict Response | 409 Conflict | Seats no longer available |

**Implementation** (`src/modules/booking/booking.service.ts`):

```typescript
// Atomic update with version check and seat availability validation
const result = await this.showtimeModel.updateOne(
  {
    _id: showtime._id,
    version: showtime.version,  // Optimistic lock check
    status: ShowtimeStatus.SCHEDULED,
    $and: seatConditions,  // Each seat must be available or expired-hold
  },
  {
    $set: setOperations,
    $inc: { version: 1, available_seats: -seatIds.length },
  },
);

// If modifiedCount === 0, version mismatch occurred - retry
if (result.modifiedCount === 0) {
  // Retry or throw ConflictException
}
```

### 4.2 Race Condition Prevention Flow

```
Request                                                          Response
   |                                                                 ^
   v                                                                 |
+--+------------------------------------------------------------------+--+
|                        LAYER 1: Redis Lock                            |
+-----------------------------------------------------------------------+
   |                                                                 ^
   | Lock acquired?                                         Release lock
   |    |                                                            |
   |    +-- NO --> Return 409 Conflict                               |
   |    |          "System busy, try again"                          |
   |    |                                                            |
   v    v YES                                                        |
+--+------------------------------------------------------------------+--+
|                    LAYER 2: MongoDB Optimistic Lock                   |
+-----------------------------------------------------------------------+
   |                                                                 ^
   v                                                                 |
+--+------------------+                                              |
| 1. Read showtime    |                                              |
|    with version     |                                              |
+---------------------+                                              |
   |                                                                 |
   v                                                                 |
+--+------------------+                                              |
| 2. Validate seats   |                                              |
|    - Status check   |                                              |
|    - Expiry check   |                                              |
+---------------------+                                              |
   |                                                                 |
   v                                                                 |
+--+------------------+      Version mismatch?                       |
| 3. Atomic update    +------- YES -----> Retry (max 3x)             |
|    with version     |                        |                     |
|    check            |                        v                     |
+---------------------+              Max retries reached?            |
   |                                       |                         |
   | SUCCESS                               v YES                     |
   v                               Return 409 Conflict               |
+--+------------------+            "Seats no longer available"       |
| 4. Create Booking   |                                              |
+---------------------+                                              |
   |                                                                 |
   +---------------------------------------------------------------->+
```

### 4.3 Idempotency Implementation

Prevents duplicate operations when users accidentally submit the same request multiple times.

#### Request Header

```
X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

**Note**: Must be UUID v4 format.

#### Idempotency Flow

```
                           +----------------------+
                           |    Incoming Request  |
                           +----------+-----------+
                                      |
                           +----------v-----------+
                           | Check X-Idempotency  |
                           | -Key in Database     |
                           +----------+-----------+
                                      |
         +----------------------------+----------------------------+
         |                            |                            |
         v                            v                            v
   +-----+-----+              +-------+-------+             +------+------+
   | NOT FOUND |              | status =      |             | status =    |
   +-----+-----+              | 'completed'   |             | 'processing'|
         |                    +-------+-------+             +------+------+
         v                            |                            |
   +-----+-----+                      v                            v
   | Create    |              +-------+-------+             +------+------+
   | record    |              | Return cached |             | Return 409  |
   | status =  |              | response      |             | Conflict    |
   |'processing|              +---------------+             +-------------+
   +-----+-----+
         |
         v
   +-----+-----+
   | Process   |
   | request   |
   +-----+-----+
         |
    +----+----+
    |         |
    v         v
SUCCESS    FAILED
    |         |
    v         v
+---+---+ +---+---+
|status | |status |
|='com- | |='fai- |
|pleted'| |led'   |
+---+---+ +---+---+
    |         |
    v         v
  Cache     Cache
 response   error
```

#### Implementation Details (`src/modules/payment/idempotency.service.ts`)

```typescript
// Request body is hashed to ensure same key = same request
hashRequestBody(body: Record<string, unknown>): string {
  const sortedBody = this.sortObjectKeys(body);  // Consistent ordering
  const bodyString = JSON.stringify(sortedBody);
  return crypto.createHash('sha256').update(bodyString).digest('hex');
}

// Check idempotency key
async checkIdempotencyKey(key, userId, requestPath, requestHash, resourceType) {
  const existingRecord = await this.idempotencyKeyModel.findOne({
    key,
    user_id: userObjectId,
  });

  // Case 1: New request
  if (!existingRecord) {
    return { isNew: true, record: await createNewRecord() };
  }

  // Case 2: Same key, different body - reject
  if (existingRecord.request_hash !== requestHash) {
    throw new BadRequestException('Key used with different request body');
  }

  // Case 3: Already completed - return cached
  if (existingRecord.status === 'completed') {
    return { isNew: false, cachedResponse: existingRecord.response_body };
  }

  // Case 4: Still processing - conflict
  if (existingRecord.status === 'processing') {
    throw new ConflictException('Request is being processed');
  }
}
```

#### Idempotency Key Schema

```typescript
// Unique compound index prevents duplicate keys per user
IdempotencyKeySchema.index({ key: 1, user_id: 1 }, { unique: true });

// TTL index auto-cleans expired keys (24 hours)
IdempotencyKeySchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
```

### 4.4 Seat Hold & Expiry

Implements a reservation system that temporarily holds seats during the booking process.

#### Configuration

| Parameter | Value | Description |
|-----------|-------|-------------|
| Hold Duration | 10 minutes | Time user has to complete payment |
| Cleanup Interval | Every 1 minute | Cron job frequency |
| Seat States | `available`, `held`, `booked` | Lifecycle states |

#### Hold Flow

```
+-------------+     holdSeats()      +-------------+     confirmBooking()    +-------------+
|  AVAILABLE  | ------------------> |    HELD     | ----------------------> |   BOOKED    |
+-------------+                      +------+------+                         +-------------+
                                            |
                                            | 10 min timeout
                                            v
                                     +------+------+
                                     | Cron Job:   |
                                     | Release     |
                                     | expired     |
                                     | holds       |
                                     +------+------+
                                            |
                                            v
                                     +------+------+
                                     |  AVAILABLE  |
                                     +-------------+
```

#### Implementation

```typescript
// Cron job runs every minute to release expired holds
@Cron(CronExpression.EVERY_MINUTE)
async releaseExpiredHolds(): Promise<void> {
  const now = new Date();

  // Find all expired pending bookings
  const expiredBookings = await this.bookingModel.find({
    status: BookingStatus.PENDING,
    hold_expires_at: { $lt: now },
  });

  for (const booking of expiredBookings) {
    // Release seats back to available
    await this.releaseSeats(booking.showtime_id, booking.seats);

    // Update booking status to expired
    booking.status = BookingStatus.EXPIRED;
    await booking.save();
  }
}
```

---

## 5. Database Design

### Collections

#### Showtime

Stores showtime information with embedded seat map and version for optimistic locking.

```typescript
{
  _id: ObjectId,
  movie_id: ObjectId,
  cinema_id: ObjectId,
  screen_id: string,
  start_time: Date,
  end_time: Date,
  price: {
    standard: number,  // Price in VND
    vip: number,
    couple: number
  },
  total_seats: number,
  available_seats: number,
  seats: Map<string, {
    status: 'available' | 'held' | 'booked',
    held_until?: Date,
    booking_id?: ObjectId,
    seat_type?: 'standard' | 'vip' | 'couple'
  }>,
  version: number,  // Optimistic lock version
  status: 'scheduled' | 'cancelled' | 'completed'
}
```

#### Booking

```typescript
{
  _id: ObjectId,
  booking_code: string,      // e.g., "BK-ABC12345"
  user_id: ObjectId,
  showtime_id: ObjectId,
  seats: [{
    seat_id: string,
    seat_type: string,
    price: number
  }],
  total_amount: number,
  discount_amount: number,
  final_amount: number,
  currency: string,
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired',
  held_at: Date,
  hold_expires_at: Date,     // held_at + 10 minutes
  idempotency_key: string,   // Unique per booking
  confirmed_at?: Date,
  cancelled_at?: Date
}
```

#### IdempotencyKey

```typescript
{
  _id: ObjectId,
  key: string,               // UUID v4 from client
  user_id: ObjectId,
  request_path: string,
  request_hash: string,      // SHA256 of request body
  resource_type: 'payment' | 'booking' | 'refund',
  status: 'processing' | 'completed' | 'failed',
  response_status?: number,
  response_body?: object,    // Cached response
  expires_at: Date           // TTL: 24 hours
}
```

### Database Indexes

Performance-critical indexes for common query patterns:

```typescript
// Booking indexes
BookingSchema.index({ user_id: 1, status: 1 });
BookingSchema.index({ user_id: 1, createdAt: -1 });
BookingSchema.index({ showtime_id: 1, status: 1 });

// Partial index for expired holds cleanup (only indexes pending bookings)
BookingSchema.index(
  { status: 1, hold_expires_at: 1 },
  { partialFilterExpression: { status: 'pending' } }
);

// Showtime indexes
ShowtimeSchema.index({ movie_id: 1, start_time: 1 });
ShowtimeSchema.index({ status: 1, start_time: 1, available_seats: 1 });

// Partial index for available seats
ShowtimeSchema.index(
  { movie_id: 1, status: 1, start_time: 1, available_seats: 1 },
  { partialFilterExpression: { available_seats: { $gt: 0 } } }
);

// Idempotency key indexes
IdempotencyKeySchema.index({ key: 1, user_id: 1 }, { unique: true });
IdempotencyKeySchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 }); // TTL
```

---

## 6. Installation & Setup

### Prerequisites

- Node.js >= 18.x
- MongoDB >= 6.0
- Redis >= 7.0
- npm or yarn

### Installation Steps

```bash
# 1. Clone the repository
git clone <repository-url>
cd fs-booking

# 2. Install dependencies
npm install

# 3. Copy environment configuration
cp .env.example .env

# 4. Configure environment variables
# Edit .env file with your settings:
#   MONGO_URI=mongodb://localhost:27017/fs-booking
#   REDIS_URL=redis://localhost:6379
#   PORT=3000

# 5. Start MongoDB and Redis
# Using Docker (optional):
docker run -d -p 27017:27017 --name mongodb mongo:6
docker run -d -p 6379:6379 --name redis redis:7

# 6. Start development server
npm run start:dev
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MONGO_URI` | MongoDB connection string | `mongodb://localhost:27017/fs-booking` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `PORT` | Application port | `3000` |
| `PAYMENT_GATEWAY_URL` | Payment gateway base URL | `https://payment.example.com` |
| `DEFAULT_RETURN_URL` | Default payment callback URL | `https://app.example.com/payment/callback` |

### Available Scripts

```bash
npm run start:dev     # Start with hot-reload
npm run start:prod    # Start production build
npm run build         # Build for production
npm run test          # Run unit tests
npm run test:e2e      # Run end-to-end tests
npm run test:cov      # Run tests with coverage
npm run lint          # Run ESLint
npm run format        # Run Prettier
```

---

## 7. API Documentation

### Authentication

All endpoints require authentication. Include the following headers:

```
Authorization: Bearer <jwt-token>
X-User-Id: <user-id>  # For development/testing only
```

### Booking Endpoints

#### Hold Seats

Temporarily holds seats for 10 minutes while user completes payment.

```
POST /api/bookings/hold
```

**Headers**:
| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | Bearer token |
| `X-Idempotency-Key` | Yes | UUID v4 to prevent duplicate bookings |

**Request Body**:
```json
{
  "showtime_id": "64a7b8c9d0e1f2a3b4c5d6e7",
  "seats": ["A1", "A2", "A3"]
}
```

**Success Response** (201 Created):
```json
{
  "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
  "booking_code": "BK-ABC12345",
  "showtime_id": "64a7b8c9d0e1f2a3b4c5d6e7",
  "seats": ["A1", "A2", "A3"],
  "total_amount": 300000,
  "final_amount": 300000,
  "currency": "VND",
  "status": "pending",
  "held_at": "2024-01-15T10:30:00.000Z",
  "hold_expires_at": "2024-01-15T10:40:00.000Z",
  "created_at": "2024-01-15T10:30:00.000Z"
}
```

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_SEAT` | Seat does not exist |
| 400 | `SHOWTIME_NOT_AVAILABLE` | Showtime is cancelled/completed |
| 400 | `SHOWTIME_ALREADY_STARTED` | Cannot book past showtime |
| 409 | `SEAT_ALREADY_BOOKED` | Seat is already booked |
| 409 | `SEAT_HELD_BY_ANOTHER` | Seat is held by another user |
| 409 | `BOOKING_LOCK_FAILED` | System busy, try again |

---

#### Confirm Booking

Confirms the booking and initiates payment.

```
POST /api/bookings/:id/confirm
```

**Headers**:
| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | Bearer token |
| `X-Idempotency-Key` | Yes | UUID v4 to prevent duplicate payments |

**Request Body**:
```json
{
  "payment_method": "momo",
  "return_url": "https://your-app.com/payment/callback"
}
```

**Success Response** (200 OK):
```json
{
  "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
  "booking_code": "BK-ABC12345",
  "payment_id": "PAY_550e8400-e29b-41d4-a716-446655440000",
  "payment_url": "https://payment.example.com/pay?...",
  "expires_at": "2024-01-15T10:40:00.000Z"
}
```

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `BOOKING_NOT_PENDING` | Booking already confirmed/cancelled |
| 400 | `BOOKING_HOLD_EXPIRED` | Hold expired, create new booking |
| 403 | `BOOKING_NOT_OWNED` | Cannot confirm another user's booking |
| 404 | `BOOKING_NOT_FOUND` | Booking does not exist |

---

#### Get Booking Details

```
GET /api/bookings/:id
```

**Success Response** (200 OK):
```json
{
  "id": "64a7b8c9d0e1f2a3b4c5d6e8",
  "booking_code": "BK-ABC12345",
  "showtime_id": "64a7b8c9d0e1f2a3b4c5d6e7",
  "user_id": "507f1f77bcf86cd799439011",
  "seats": [
    { "seat_id": "A1", "seat_type": "standard", "price": 100000 },
    { "seat_id": "A2", "seat_type": "standard", "price": 100000 }
  ],
  "total_amount": 200000,
  "discount_amount": 0,
  "final_amount": 200000,
  "currency": "VND",
  "status": "pending",
  "held_at": "2024-01-15T10:30:00.000Z",
  "hold_expires_at": "2024-01-15T10:40:00.000Z",
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

---

#### Cancel Booking

Cancels a pending booking and releases held seats.

```
DELETE /api/bookings/:id
```

**Success Response** (200 OK):
```json
{
  "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
  "booking_code": "BK-ABC12345",
  "status": "cancelled",
  "cancelled_at": "2024-01-15T10:35:00.000Z",
  "seats_released": ["A1", "A2"]
}
```

---

### Payment Endpoints

#### Create Payment

```
POST /api/payments
```

**Headers**:
| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | Bearer token |
| `X-Idempotency-Key` | Yes | UUID v4 (format: `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`) |

**Request Body**:
```json
{
  "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
  "payment_method": "momo",
  "return_url": "https://your-app.com/payment/callback"
}
```

Supported payment methods: `momo`, `vnpay`, `zalopay`, `card`

**Success Response** (201 Created):
```json
{
  "success": true,
  "payment_id": "64a7b8c9d0e1f2a3b4c5d6e9",
  "payment_url": "https://payment.example.com/momo/pay/TXN_MOMO_abc123",
  "expires_at": "2024-01-15T10:45:00.000Z",
  "message": "Vui long hoan tat thanh toan trong 15 phut"
}
```

---

#### Payment Webhook

Endpoint for payment gateway callbacks.

```
POST /api/payments/webhook/:provider
```

**Parameters**:
- `provider`: Payment provider (`momo`, `vnpay`, `zalopay`, `card`)

**Request Body**:
```json
{
  "transaction_id": "TXN_MOMO_abc123",
  "status": "success",
  "amount": 200000,
  "paid_at": "2024-01-15T10:35:00.000Z"
}
```

**Note**: This endpoint is idempotent. Multiple webhook calls with the same transaction will not cause duplicate processing.

---

#### Get Payment Details

```
GET /api/payments/:id
```

**Success Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "64a7b8c9d0e1f2a3b4c5d6e9",
    "booking_id": "64a7b8c9d0e1f2a3b4c5d6e8",
    "amount": 200000,
    "currency": "VND",
    "payment_method": "momo",
    "status": "completed",
    "payment_url": "https://payment.example.com/momo/pay/TXN_MOMO_abc123",
    "paid_at": "2024-01-15T10:35:00.000Z",
    "expires_at": "2024-01-15T10:45:00.000Z",
    "created_at": "2024-01-15T10:30:00.000Z"
  }
}
```

---

## 8. Testing

### Unit Tests

```bash
# Run all unit tests
npm run test

# Run with coverage
npm run test:cov

# Run specific test file
npm run test -- booking.service.spec.ts

# Watch mode
npm run test:watch
```

### E2E Tests

```bash
npm run test:e2e
```

### Concurrency Test Scenario

To verify race condition handling, simulate 1000 concurrent requests for the same seat:

#### Using Artillery

Create `concurrency-test.yml`:

```yaml
config:
  target: "http://localhost:3000"
  phases:
    - duration: 1
      arrivalRate: 1000  # 1000 requests in 1 second
  defaults:
    headers:
      Authorization: "Bearer <test-token>"
      Content-Type: "application/json"

scenarios:
  - name: "Race condition test"
    flow:
      - post:
          url: "/api/bookings/hold"
          headers:
            X-Idempotency-Key: "{{ $uuid }}"
          json:
            showtime_id: "64a7b8c9d0e1f2a3b4c5d6e7"
            seats: ["A1"]
```

Run test:

```bash
artillery run concurrency-test.yml
```

#### Using k6

Create `concurrency-test.js`:

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  vus: 1000,
  iterations: 1000,
};

export default function () {
  const payload = JSON.stringify({
    showtime_id: '64a7b8c9d0e1f2a3b4c5d6e7',
    seats: ['A1'],
  });

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer <test-token>',
    'X-Idempotency-Key': uuidv4(),
  };

  const res = http.post('http://localhost:3000/api/bookings/hold', payload, { headers });

  check(res, {
    'status is 201 or 409 or 400': (r) => [201, 409, 400].includes(r.status),
  });
}
```

Run test:

```bash
k6 run concurrency-test.js
```

#### Expected Results

| Metric | Expected Value |
|--------|----------------|
| Successful bookings | Exactly 1 |
| Conflict responses (409) | ~999 |
| Overbookings | 0 |

The test validates that:
1. Only 1 booking is created for the contested seat
2. All other requests receive 409 (Conflict) or 400 (Bad Request)
3. No overbooking occurs under any circumstances

---

## 9. Tech Stack

| Category | Technology | Version |
|----------|-----------|---------|
| **Runtime** | Node.js | >= 18.x |
| **Framework** | NestJS | 11.x |
| **Language** | TypeScript | 5.x |
| **Database** | MongoDB | >= 6.0 |
| **ODM** | Mongoose | 9.x |
| **Cache/Lock** | Redis | >= 7.0 |
| **Redis Client** | ioredis | 5.x |
| **Validation** | class-validator | 0.14.x |
| **Scheduling** | @nestjs/schedule | 6.x |
| **Testing** | Jest | 30.x |

---

## License

UNLICENSED - Private project

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## Acknowledgments

This project was built as a learning exercise for handling high-concurrency scenarios in Node.js/NestJS applications, focusing on:

- Distributed systems patterns
- Database transaction management
- Race condition prevention
- Idempotent API design
