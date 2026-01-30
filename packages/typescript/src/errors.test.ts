import { describe, it, expect } from "vitest";
import {
  PlurimError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "./errors.js";

describe("PlurimError", () => {
  it("should create error with message", () => {
    const error = new PlurimError("Something went wrong");
    expect(error.message).toBe("Something went wrong");
    expect(error.name).toBe("PlurimError");
    expect(error.statusCode).toBeUndefined();
  });

  it("should create error with message and status code", () => {
    const error = new PlurimError("Server error", 500);
    expect(error.message).toBe("Server error");
    expect(error.statusCode).toBe(500);
  });

  it("should be instance of Error", () => {
    const error = new PlurimError("Test");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PlurimError);
  });
});

describe("AuthenticationError", () => {
  it("should have default message", () => {
    const error = new AuthenticationError();
    expect(error.message).toBe("Invalid or missing API key");
    expect(error.statusCode).toBe(401);
    expect(error.name).toBe("AuthenticationError");
  });

  it("should accept custom message", () => {
    const error = new AuthenticationError("Token expired");
    expect(error.message).toBe("Token expired");
    expect(error.statusCode).toBe(401);
  });

  it("should be instance of PlurimError", () => {
    const error = new AuthenticationError();
    expect(error).toBeInstanceOf(PlurimError);
    expect(error).toBeInstanceOf(AuthenticationError);
  });
});

describe("NotFoundError", () => {
  it("should have default message", () => {
    const error = new NotFoundError();
    expect(error.message).toBe("Resource not found");
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe("NotFoundError");
  });

  it("should accept custom message", () => {
    const error = new NotFoundError("Blueprint not found");
    expect(error.message).toBe("Blueprint not found");
  });

  it("should be instance of PlurimError", () => {
    const error = new NotFoundError();
    expect(error).toBeInstanceOf(PlurimError);
  });
});

describe("RateLimitError", () => {
  it("should have default message", () => {
    const error = new RateLimitError();
    expect(error.message).toBe("Rate limit exceeded");
    expect(error.statusCode).toBe(429);
    expect(error.name).toBe("RateLimitError");
  });

  it("should accept custom message", () => {
    const error = new RateLimitError("Too many requests, try again in 60s");
    expect(error.message).toBe("Too many requests, try again in 60s");
  });
});

describe("ValidationError", () => {
  it("should require message", () => {
    const error = new ValidationError("Invalid field: title");
    expect(error.message).toBe("Invalid field: title");
    expect(error.statusCode).toBe(422);
    expect(error.name).toBe("ValidationError");
  });

  it("should be instance of PlurimError", () => {
    const error = new ValidationError("Test");
    expect(error).toBeInstanceOf(PlurimError);
  });
});
