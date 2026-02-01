import { Global, Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { DistributedLockService } from './distributed-lock.service';
import { SeatReservationService } from './seat-reservation.service';
import { REDIS_CLIENT } from './redis.constants';

/**
 * RedisModule provides Redis client and related services
 * Marked as @Global() so it can be used across all modules without importing
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService): Redis => {
        const logger = new Logger('RedisModule');
        const redisUrl =
          configService.get<string>('REDIS_URL') || 'redis://localhost:6379';

        logger.log(`Connecting to Redis at ${redisUrl}`);

        const redis = new Redis(redisUrl, {
          // Reconnection settings
          retryStrategy: (times: number) => {
            if (times > 10) {
              logger.error('Redis max retries reached, giving up');
              return null; // Stop retrying
            }
            const delay = Math.min(times * 100, 3000);
            logger.warn(
              `Redis connection attempt ${times}, retrying in ${delay}ms`,
            );
            return delay;
          },

          // Connection settings
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          connectTimeout: 10000,

          // Keep-alive settings
          keepAlive: 30000,
        });

        redis.on('connect', () => {
          logger.log('Redis connected');
        });

        redis.on('ready', () => {
          logger.log('Redis ready to accept commands');
        });

        redis.on('error', (error: Error) => {
          logger.error(`Redis error: ${error.message}`);
        });

        redis.on('close', () => {
          logger.warn('Redis connection closed');
        });

        redis.on('reconnecting', () => {
          logger.log('Redis reconnecting...');
        });

        return redis;
      },
      inject: [ConfigService],
    },
    RedisService,
    DistributedLockService,
    SeatReservationService,
  ],
  exports: [RedisService, DistributedLockService, SeatReservationService, REDIS_CLIENT],
})
export class RedisModule {}
