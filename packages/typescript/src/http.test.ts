import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpClient } from "./http.js";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  PlurimError,
} from "./errors.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("HttpClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear env vars
    delete process.env.PLURUM_API_KEY;
    delete process.env.PLURUM_API_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should use default API URL if not provided", () => {
      const client = new HttpClient();
      // Access private field via test
      expect((client as any).apiUrl).toBe("https://api.plurum.ai");
    });

    it("should use provided API URL", () => {
      const client = new HttpClient({ apiUrl: "http://localhost:8000" });
      expect((client as any).apiUrl).toBe("http://localhost:8000");
    });

    it("should strip trailing slash from API URL", () => {
      const client = new HttpClient({ apiUrl: "http://localhost:8000/" });
      expect((client as any).apiUrl).toBe("http://localhost:8000");
    });

    it("should use API key from config", () => {
      const client = new HttpClient({ apiKey: "test_key" });
      expect((client as any).apiKey).toBe("test_key");
    });

    it("should use API key from environment", () => {
      process.env.PLURUM_API_KEY = "env_key";
      const client = new HttpClient();
      expect((client as any).apiKey).toBe("env_key");
    });

    it("should prefer config API key over environment", () => {
      process.env.PLURUM_API_KEY = "env_key";
      const client = new HttpClient({ apiKey: "config_key" });
      expect((client as any).apiKey).toBe("config_key");
    });

    it("should use default timeout", () => {
      const client = new HttpClient();
      expect((client as any).timeout).toBe(30000);
    });

    it("should use provided timeout", () => {
      const client = new HttpClient({ timeout: 60000 });
      expect((client as any).timeout).toBe(60000);
    });
  });

  describe("GET requests", () => {
    it("should make GET request with correct URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: "test" }),
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });
      await client.get("/api/v1/test");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/test",
        expect.objectContaining({
          method: "GET",
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    it("should append query params to URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });
      await client.get("/api/v1/blueprints", { limit: 10, status: "published" });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain("limit=10");
      expect(calledUrl).toContain("status=published");
    });

    it("should handle array params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });
      await client.get("/api/v1/blueprints", { tags: ["docker", "aws"] });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain("tags=docker");
      expect(calledUrl).toContain("tags=aws");
    });

    it("should skip undefined params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });
      await client.get("/api/v1/blueprints", { limit: 10, status: undefined });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain("limit=10");
      expect(calledUrl).not.toContain("status");
    });
  });

  describe("POST requests", () => {
    it("should make POST request with JSON body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 1 }),
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });
      await client.post("/api/v1/test", { name: "test" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/test",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "test" }),
        })
      );
    });

    it("should include auth header when requiresAuth is true", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 1 }),
      });

      const client = new HttpClient({
        apiUrl: "http://localhost:8000",
        apiKey: "test_key",
      });
      await client.post("/api/v1/test", { name: "test" }, true);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test_key",
          },
        })
      );
    });

    it("should throw AuthenticationError when auth required but no key", async () => {
      const client = new HttpClient({ apiUrl: "http://localhost:8000" });

      await expect(
        client.post("/api/v1/test", { name: "test" }, true)
      ).rejects.toThrow(AuthenticationError);
    });
  });

  describe("PUT requests", () => {
    it("should make PUT request with JSON body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 1, updated: true }),
      });

      const client = new HttpClient({
        apiUrl: "http://localhost:8000",
        apiKey: "test_key",
      });
      await client.put("/api/v1/test/1", { name: "updated" }, true);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/test/1",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ name: "updated" }),
          headers: expect.objectContaining({
            Authorization: "Bearer test_key",
          }),
        })
      );
    });
  });

  describe("DELETE requests", () => {
    it("should make DELETE request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ deleted: true }),
      });

      const client = new HttpClient({
        apiUrl: "http://localhost:8000",
        apiKey: "test_key",
      });
      await client.delete("/api/v1/test/1", true);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/test/1",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({
            Authorization: "Bearer test_key",
          }),
        })
      );
    });
  });

  describe("Error handling", () => {
    it("should throw AuthenticationError on 401", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });

      await expect(client.get("/api/v1/test")).rejects.toThrow(
        AuthenticationError
      );
    });

    it("should throw NotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });

      await expect(client.get("/api/v1/test")).rejects.toThrow(NotFoundError);
    });

    it("should throw RateLimitError on 429", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });

      await expect(client.get("/api/v1/test")).rejects.toThrow(RateLimitError);
    });

    it("should throw ValidationError on 422 with detail", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ detail: "Title is required" }),
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });

      await expect(client.get("/api/v1/test")).rejects.toThrow(
        ValidationError
      );
    });

    it("should include detail message in ValidationError", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ detail: "Title is required" }),
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });

      try {
        await client.get("/api/v1/test");
      } catch (error) {
        expect((error as Error).message).toContain("Title is required");
      }
    });

    it("should throw PlurimError on other errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const client = new HttpClient({ apiUrl: "http://localhost:8000" });

      await expect(client.get("/api/v1/test")).rejects.toThrow(PlurimError);
    });
  });
});
