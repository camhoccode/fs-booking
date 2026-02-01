import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from './redis.service';
import {
  DEFAULT_LOCK_TTL,
  DEFAULT_MAX_RETRY,
  DEFAULT_RETRY_DELAY,
  LUA_SCRIPTS,
} from './redis.constants';
import { AcquireLockOptions, Lock } from './interfaces';

/**
 * DistributedLockService provides distributed locking mechanism using Redis
 * Uses Lua scripts to ensure atomic operations
 *
 * Lock value format: "{uuid}:{timestamp}"
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Generate a unique lock value
   * Format: "{uuid}:{timestamp}"
   */
  private generateLockValue(): string {
    return `${uuidv4()}:${Date.now()}`;
  }

  /**
   * Sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Calculate exponential backoff delay
   * Formula: baseDelay * 2^attempt with jitter
   */
  private calculateBackoff(baseDelay: number, attempt: number): number {
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    // Add jitter (0-50% of delay) to prevent thundering herd
    const jitter = Math.random() * exponentialDelay * 0.5;
    return Math.floor(exponentialDelay + jitter);
  }

  /**
   * Acquire a distributed lock on a resource
   *
   * @param resource The resource identifier to lock
   * @param options Lock options (ttl, maxRetry, retryDelay)
   * @returns Lock object if acquired, null if failed after all retries
   *
   * @example
   * ```typescript
   * const lock = await lockService.acquireLock('booking:showtime:123');
   * if (lock) {
   *   try {
   *     // Critical section
   *   } finally {
   *     await lockService.releaseLock(lock);
   *   }
   * }
   * ```
   */
  async acquireLock(
    resource: string,
    options: AcquireLockOptions = {},
  ): Promise<Lock | null> {
    const {
      ttl = DEFAULT_LOCK_TTL,
      maxRetry = DEFAULT_MAX_RETRY,
      retryDelay = DEFAULT_RETRY_DELAY,
    } = options;

    const lockValue = this.generateLockValue();

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        const result = await this.redisService.eval(
          LUA_SCRIPTS.ACQUIRE_LOCK,
          [resource],
          [lockValue, ttl],
        );

        if (result === 'OK') {
          const lock: Lock = {
            resource,
            value: lockValue,
            expiresAt: Date.now() + ttl,
          };

          this.logger.debug(
            `Lock acquired on "${resource}" with value "${lockValue}"`,
          );

          return lock;
        }

        // Lock not acquired, retry if attempts remaining
        if (attempt < maxRetry) {
          const backoffDelay = this.calculateBackoff(retryDelay, attempt);
          this.logger.debug(
            `Lock acquisition failed for "${resource}", retrying in ${backoffDelay}ms (attempt ${attempt + 1}/${maxRetry})`,
          );
          await this.sleep(backoffDelay);
        }
      } catch (error) {
        this.logger.error(
          `Error acquiring lock on "${resource}": ${error instanceof Error ? error.message : 'Unknown error'}`,
        );

        // Retry on error if attempts remaining
        if (attempt < maxRetry) {
          const backoffDelay = this.calculateBackoff(retryDelay, attempt);
          await this.sleep(backoffDelay);
        }
      }
    }

    this.logger.warn(
      `Failed to acquire lock on "${resource}" after ${maxRetry + 1} attempts`,
    );
    return null;
  }

  /**
   * Release a distributed lock
   *
   * Only the owner (holder of the lock value) can release the lock.
   * Uses Lua script to ensure atomic check-and-delete.
   *
   * @param lock The lock object to release
   * @returns true if released successfully, false if lock was already expired or owned by another process
   */
  async releaseLock(lock: Lock): Promise<boolean> {
    try {
      const result = await this.redisService.eval(
        LUA_SCRIPTS.RELEASE_LOCK,
        [lock.resource],
        [lock.value],
      );

      const released = result === 1;

      if (released) {
        this.logger.debug(
          `Lock released on "${lock.resource}" with value "${lock.value}"`,
        );
      } else {
        this.logger.warn(
          `Failed to release lock on "${lock.resource}" - lock not found or owned by another process`,
        );
      }

      return released;
    } catch (error) {
      this.logger.error(
        `Error releasing lock on "${lock.resource}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  /**
   * Extend a lock's TTL
   *
   * Only the owner can extend the lock. Useful for long-running operations
   * where you need to prevent the lock from expiring.
   *
   * @param lock The lock object to extend
   * @param ttl New TTL in milliseconds
   * @returns true if extended successfully, false if lock was already expired or owned by another process
   *
   * @example
   * ```typescript
   * const lock = await lockService.acquireLock('resource', { ttl: 5000 });
   * if (lock) {
   *   // ... some work ...
   *   // Extend if operation takes longer
   *   const extended = await lockService.extendLock(lock, 10000);
   *   if (!extended) {
   *     // Lock was lost, handle accordingly
   *   }
   * }
   * ```
   */
  async extendLock(lock: Lock, ttl: number): Promise<boolean> {
    try {
      const result = await this.redisService.eval(
        LUA_SCRIPTS.EXTEND_LOCK,
        [lock.resource],
        [lock.value, ttl],
      );

      const extended = result === 1;

      if (extended) {
        // Update the lock's expiration time
        lock.expiresAt = Date.now() + ttl;
        this.logger.debug(
          `Lock extended on "${lock.resource}" for ${ttl}ms`,
        );
      } else {
        this.logger.warn(
          `Failed to extend lock on "${lock.resource}" - lock not found or owned by another process`,
        );
      }

      return extended;
    } catch (error) {
      this.logger.error(
        `Error extending lock on "${lock.resource}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  /**
   * Check if a lock is still valid (not expired based on local time)
   * Note: This is a local check and doesn't verify Redis state
   */
  isLockValid(lock: Lock): boolean {
    return Date.now() < lock.expiresAt;
  }

  /**
   * Execute a function while holding a lock
   * Automatically acquires and releases the lock
   *
   * @param resource The resource identifier to lock
   * @param fn The function to execute while holding the lock
   * @param options Lock options
   * @returns The result of the function, or null if lock couldn't be acquired
   *
   * @example
   * ```typescript
   * const result = await lockService.withLock('resource:123', async () => {
   *   // Critical section - executed while holding the lock
   *   return await someOperation();
   * });
   * ```
   */
  async withLock<T>(
    resource: string,
    fn: () => Promise<T>,
    options: AcquireLockOptions = {},
  ): Promise<{ success: true; result: T } | { success: false; result: null }> {
    const lock = await this.acquireLock(resource, options);

    if (!lock) {
      return { success: false, result: null };
    }

    try {
      const result = await fn();
      return { success: true, result };
    } finally {
      await this.releaseLock(lock);
    }
  }
}
