/**
 * Standard API response interface
 */
export interface BaseResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  timestamp: string;
}

/**
 * Paginated response interface
 */
export interface PaginatedResponse<T> extends BaseResponse<T[]> {
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

/**
 * Error response interface
 */
export interface ErrorResponse {
  statusCode: number;
  errorCode: string;
  message: string;
  timestamp: string;
  path: string;
  details?: Record<string, unknown>;
}
