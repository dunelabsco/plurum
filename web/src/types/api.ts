/**
 * API-related TypeScript types for responses and errors.
 */

export interface APIError {
  detail: string;
  status_code?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface MessageResponse {
  message: string;
}
