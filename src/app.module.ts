import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';

// Feature modules
import { RedisModule } from './modules/redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { MovieModule } from './modules/movie/movie.module';
import { CinemaModule } from './modules/cinema/cinema.module';
import { ShowtimeModule } from './modules/showtime/showtime.module';
import { BookingModule } from './modules/booking/booking.module';
import { PaymentModule } from './modules/payment/payment.module';

/**
 * AppModule - Root module of the booking system
 *
 * Configuration:
 * - ConfigModule: Global configuration with .env support
 * - MongooseModule: MongoDB connection via MONGO_URI
 * - ScheduleModule: Task scheduling for cleanup jobs
 *
 * Feature Modules:
 * - RedisModule: Distributed locking and caching (global)
 * - MovieModule: Movie management
 * - CinemaModule: Cinema and screen management
 * - ShowtimeModule: Showtime scheduling and seat management
 * - BookingModule: Booking workflow with seat hold/confirm
 * - PaymentModule: Payment processing with idempotency
 */
@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // MongoDB connection with async configuration
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>(
          'MONGO_URI',
          'mongodb://localhost:27017/fs-booking',
        ),
      }),
      inject: [ConfigService],
    }),

    // Task scheduling for cleanup jobs
    ScheduleModule.forRoot(),

    // Feature modules
    RedisModule,
    HealthModule,
    MovieModule,
    CinemaModule,
    ShowtimeModule,
    BookingModule,
    PaymentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
