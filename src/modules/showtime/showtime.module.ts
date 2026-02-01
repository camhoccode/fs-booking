import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Showtime, ShowtimeSchema } from './showtime.schema';
import { ShowtimeService } from './showtime.service';

/**
 * ShowtimeModule handles all showtime-related functionality
 *
 * Features:
 * - Showtime CRUD operations
 * - Seat availability management with Redis
 * - Initialize showtime seats in Redis
 * - Real-time seat status from Redis
 *
 * Dependencies:
 * - MongooseModule: For database operations
 * - RedisModule: Global module for SeatReservationService
 *
 * Architecture:
 * - Redis is the source of truth for real-time seat availability
 * - MongoDB stores persistent showtime data
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Showtime.name, schema: ShowtimeSchema }]),
  ],
  controllers: [],
  providers: [ShowtimeService],
  exports: [ShowtimeService, MongooseModule],
})
export class ShowtimeModule {}
