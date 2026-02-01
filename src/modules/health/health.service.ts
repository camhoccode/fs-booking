import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { RedisService } from '../redis/redis.service';

/**
 * Health check result interface
 */
export interface HealthCheckResult {
  status: 'ok' | 'error';
  timestamp: string;
  uptime: number;
  services: {
    mongodb: ServiceHealth;
    redis: ServiceHealth;
  };
}

/**
 * Individual service health status
 */
export interface ServiceHealth {
  status: 'up' | 'down';
  latency?: number;
  error?: string;
}

/**
 * HealthService checks the health of all dependencies
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  constructor(
    @InjectConnection()
    private readonly mongoConnection: Connection,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Perform full health check on all dependencies
   */
  async check(): Promise<HealthCheckResult> {
    const [mongoHealth, redisHealth] = await Promise.all([
      this.checkMongoDB(),
      this.checkRedis(),
    ]);

    const allHealthy =
      mongoHealth.status === 'up' && redisHealth.status === 'up';

    return {
      status: allHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      services: {
        mongodb: mongoHealth,
        redis: redisHealth,
      },
    };
  }

  /**
   * Check MongoDB connection health
   */
  private async checkMongoDB(): Promise<ServiceHealth> {
    const start = Date.now();

    try {
      // Check connection state
      if (this.mongoConnection.readyState !== 1) {
        return {
          status: 'down',
          error: `Connection state: ${this.getMongoStateString(this.mongoConnection.readyState)}`,
        };
      }

      // Ping the database
      await this.mongoConnection.db?.admin().ping();

      return {
        status: 'up',
        latency: Date.now() - start,
      };
    } catch (error) {
      this.logger.error(
        `MongoDB health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return {
        status: 'down',
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check Redis connection health
   */
  private async checkRedis(): Promise<ServiceHealth> {
    const start = Date.now();

    try {
      const pong = await this.redisService.ping();

      if (pong !== 'PONG') {
        return {
          status: 'down',
          error: `Unexpected ping response: ${pong}`,
        };
      }

      return {
        status: 'up',
        latency: Date.now() - start,
      };
    } catch (error) {
      this.logger.error(
        `Redis health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return {
        status: 'down',
        latency: Date.now() - start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Convert MongoDB connection state to human-readable string
   */
  private getMongoStateString(state: number): string {
    const states: Record<number, string> = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };
    return states[state] || 'unknown';
  }
}
