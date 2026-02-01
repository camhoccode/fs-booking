/**
 * Lock interface representing a distributed lock
 */
export interface Lock {
  /** The resource key being locked */
  resource: string;

  /** Unique lock value format: "{uuid}:{timestamp}" */
  value: string;

  /** Lock expiration time in milliseconds (Unix timestamp) */
  expiresAt: number;
}

/**
 * Options for acquiring a lock
 */
export interface AcquireLockOptions {
  /** Time-to-live for the lock in milliseconds */
  ttl?: number;

  /** Maximum number of retry attempts */
  maxRetry?: number;

  /** Base delay between retries in milliseconds (with exponential backoff) */
  retryDelay?: number;
}
