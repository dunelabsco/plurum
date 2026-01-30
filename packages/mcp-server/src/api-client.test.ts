import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlurimApiClient } from "./api-client.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("PlurimApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should strip trailing slash from API URL", () => {
      const client = new PlurimApiClient({
        apiUrl: "http://localhost:8000/",
      });
      expect((client as any).apiUrl).toBe("http://localhost:8000");
    });

    it("should store API key", () => {
      const client = new PlurimApiClient({
        apiUrl: "http://localhost:8000",
        apiKey: "test_key",
      });
      expect((client as any).apiKey).toBe("test_key");
    });
  });

  describe("search", () => {
    it("should call POST /api/v1/search", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [],
            total_found: 0,
            query: "test",
          }),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });
      await client.search({ query: "deploy docker" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/search",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ query: "deploy docker" }),
        })
      );
    });

    it("should include tags and limit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [],
            total_found: 0,
            query: "test",
          }),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });
      await client.search({
        query: "deploy docker",
        tags: ["docker", "aws"],
        limit: 5,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tags).toEqual(["docker", "aws"]);
      expect(body.limit).toBe(5);
    });
  });

  describe("getSimilar", () => {
    it("should call GET /api/v1/search/similar/:slug", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });
      await client.getSimilar("docker-aws");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/search/similar/docker-aws",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should include limit in query params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });
      await client.getSimilar("docker-aws", { limit: 10 });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain("limit=10");
    });
  });

  describe("getBlueprint", () => {
    it("should call GET /api/v1/blueprints/:slug", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "123",
            slug: "docker-aws",
            title: "Deploy Docker to AWS",
          }),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });
      await client.getBlueprint("docker-aws");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/blueprints/docker-aws",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  describe("listBlueprints", () => {
    it("should call GET /api/v1/blueprints", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });
      await client.listBlueprints();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/blueprints",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("should include query params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });
      await client.listBlueprints({
        limit: 10,
        offset: 5,
        status: "published",
        tags: ["docker"],
      });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain("limit=10");
      expect(calledUrl).toContain("offset=5");
      expect(calledUrl).toContain("status=published");
      expect(calledUrl).toContain("tags=docker");
    });
  });

  describe("createBlueprint", () => {
    it("should call POST /api/v1/blueprints with auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "123",
            slug: "new-blueprint",
          }),
      });

      const client = new PlurimApiClient({
        apiUrl: "http://localhost:8000",
        apiKey: "test_key",
      });
      await client.createBlueprint({
        title: "New Blueprint",
        goal_description: "Create something",
        strategy: "Use this strategy",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/blueprints",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test_key",
          }),
        })
      );
    });

    it("should throw error if no API key", async () => {
      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });

      await expect(
        client.createBlueprint({
          title: "New",
          goal_description: "Goal",
          strategy: "Strategy",
        })
      ).rejects.toThrow("API key required");
    });
  });

  describe("vote", () => {
    it("should call POST /api/v1/feedback/votes with auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ message: "Vote recorded" }),
      });

      const client = new PlurimApiClient({
        apiUrl: "http://localhost:8000",
        apiKey: "test_key",
      });
      await client.vote({
        blueprint_identifier: "docker-aws",
        vote_type: "up",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/api/v1/feedback/votes",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test_key",
          }),
          body: JSON.stringify({
            blueprint_identifier: "docker-aws",
            vote_type: "up",
          }),
        })
      );
    });
  });

  describe("reportExecution", () => {
    it("should call POST /api/v1/feedback/executions with auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ message: "Execution recorded" }),
      });

      const client = new PlurimApiClient({
        apiUrl: "http://localhost:8000",
        apiKey: "test_key",
      });
      await client.reportExecution({
        blueprint_identifier: "docker-aws",
        success: true,
        execution_time_ms: 5000,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.blueprint_identifier).toBe("docker-aws");
      expect(body.success).toBe(true);
      expect(body.execution_time_ms).toBe(5000);
    });
  });

  describe("error handling", () => {
    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not found"),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });

      await expect(client.getBlueprint("nonexistent")).rejects.toThrow(
        "Plurum API error (404): Not found"
      );
    });

    it("should throw on 401", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const client = new PlurimApiClient({ apiUrl: "http://localhost:8000" });

      await expect(client.search({ query: "test" })).rejects.toThrow("401");
    });
  });
});
