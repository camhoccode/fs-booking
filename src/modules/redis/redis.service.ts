import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * RedisService provides basic Redis operations
 * Wraps ioredis client with NestJS lifecycle management
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * Get the underlying Redis client for advanced operations
   */
  getClient(): Redis {
    return this.redis;
  }

  /**
   * Get a value by key
   */
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /**
   * Set a value with optional TTL
   * @param key Redis key
   * @param value Value to store
   * @param ttlMs TTL in milliseconds (optional)
   */
  async set(key: string, value: string, ttlMs?: number): Promise<'OK'> {
    if (ttlMs) {
      return this.redis.set(key, value, 'PX', ttlMs);
    }
    return this.redis.set(key, value);
  }

  /**
   * Set a value only if key doesn't exist
   * @param key Redis key
   * @param value Value to store
   * @param ttlMs TTL in milliseconds
   */
  async setNX(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<'OK' | null> {
    return this.redis.set(key, value, 'PX', ttlMs, 'NX');
  }

  /**
   * Delete a key
   */
  async del(key: string): Promise<number> {
    return this.redis.del(key);
  }

  /**
   * Delete multiple keys
   */
  async delMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.redis.del(...keys);
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  /**
   * Set expiration on a key in milliseconds
   */
  async pexpire(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.pexpire(key, ttlMs);
    return result === 1;
  }

  /**
   * Get TTL of a key in milliseconds
   */
  async pttl(key: string): Promise<number> {
    return this.redis.pttl(key);
  }

  /**
   * Increment a value
   */
  async incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  /**
   * Increment with expiration (for rate limiting)
   */
  async incrWithExpiry(key: string, ttlMs: number): Promise<number> {
    const multi = this.redis.multi();
    multi.incr(key);
    multi.pexpire(key, ttlMs);
    const results = await multi.exec();

    if (!results || results[0][0]) {
      throw new Error('Failed to increment with expiry');
    }

    return results[0][1] as number;
  }

  /**
   * Add member to a sorted set with score
   */
  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.redis.zadd(key, score, member);
  }

  /**
   * Remove members from sorted set by score range
   */
  async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number> {
    return this.redis.zremrangebyscore(key, min, max);
  }

  /**
   * Get members from sorted set by score range
   */
  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    return this.redis.zrangebyscore(key, min, max);
  }

  /**
   * Execute a Lua script
   */
  async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    return this.redis.eval(script, keys.length, ...keys, ...args);
  }

  /**
   * Load a Lua script and return its SHA hash
   * The script is cached in Redis for later execution via EVALSHA
   *
   * @param script The Lua script to load
   * @returns SHA1 hash of the script
   */
  async scriptLoad(script: string): Promise<string> {
    return this.redis.script('LOAD', script) as Promise<string>;
  }

  /**
   * Execute a Lua script by its SHA hash
   * More efficient than eval() for frequently used scripts
   *
   * @param sha SHA1 hash of the script (obtained from scriptLoad)
   * @param keys Array of Redis keys used in the script
   * @param args Array of arguments passed to the script
   * @returns Script execution result
   *
   * @throws Error with 'NOSCRIPT' if the script is not cached
   */
  async evalsha(
    sha: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    return this.redis.evalsha(sha, keys.length, ...keys, ...args);
  }

  /**
   * Check if scripts exist in the script cache
   *
   * @param shas Array of SHA1 hashes to check
   * @returns Array of 0/1 indicating existence
   */
  async scriptExists(shas: string[]): Promise<number[]> {
    return this.redis.script('EXISTS', ...shas) as Promise<number[]>;
  }

  /**
   * Flush the script cache
   * Use with caution - affects all loaded scripts
   */
  async scriptFlush(): Promise<'OK'> {
    return this.redis.script('FLUSH') as Promise<'OK'>;
  }

  /**
   * Execute multiple commands in a pipeline
   */
  pipeline(): ReturnType<Redis['pipeline']> {
    return this.redis.pipeline();
  }

  /**
   * Hash operations - Set field value
   */
  async hset(
    key: string,
    field: string,
    value: string,
  ): Promise<number> {
    return this.redis.hset(key, field, value);
  }

  /**
   * Hash operations - Get field value
   */
  async hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget(key, field);
  }

  /**
   * Hash operations - Get all fields and values
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  /**
   * Hash operations - Delete fields
   */
  async hdel(key: string, ...fields: string[]): Promise<number> {
    return this.redis.hdel(key, ...fields);
  }

  /**
   * Hash operations - Get number of fields
   */
  async hlen(key: string): Promise<number> {
    return this.redis.hlen(key);
  }

  /**
   * Set expiration on a key in seconds
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    const result = await this.redis.expire(key, seconds);
    return result === 1;
  }

  /**
   * Decrement a value
   */
  async decr(key: string): Promise<number> {
    return this.redis.decr(key);
  }

  /**
   * Decrement by a specific amount
   */
  async decrby(key: string, amount: number): Promise<number> {
    return this.redis.decrby(key, amount);
  }

  /**
   * Increment by a specific amount
   */
  async incrby(key: string, amount: number): Promise<number> {
    return this.redis.incrby(key, amount);
  }

  /**
   * Health check - ping Redis
   */
  async ping(): Promise<string> {
    return this.redis.ping();
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing Redis connection...');
    await this.redis.quit();
    this.logger.log('Redis connection closed');
  }
}
