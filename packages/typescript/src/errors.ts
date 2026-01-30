/**
 * Error classes for the Plurum SDK
 */

export class PlurimError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "PlurimError";
    this.statusCode = statusCode;
  }
}

export class AuthenticationError extends PlurimError {
  constructor(message = "Invalid or missing API key") {
    super(message, 401);
    this.name = "AuthenticationError";
  }
}

export class NotFoundError extends PlurimError {
  constructor(message = "Resource not found") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends PlurimError {
  constructor(message = "Rate limit exceeded") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

export class ValidationError extends PlurimError {
  constructor(message: string) {
    super(message, 422);
    this.name = "ValidationError";
  }
}
