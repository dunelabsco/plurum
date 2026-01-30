import { describe, it, expect, vi, beforeEach } from "vitest";
import { BlueprintsResource } from "./blueprints.js";
import type { HttpClient } from "../http.js";

// Mock HttpClient
const createMockHttpClient = () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
});

describe("BlueprintsResource", () => {
  let mockHttp: ReturnType<typeof createMockHttpClient>;
  let blueprints: BlueprintsResource;

  beforeEach(() => {
    mockHttp = createMockHttpClient();
    blueprints = new BlueprintsResource(mockHttp as unknown as HttpClient);
  });

  describe("search", () => {
    it("should call POST /api/v1/search with query", async () => {
      mockHttp.post.mockResolvedValueOnce({
        results: [],
        total_found: 0,
        query: "test",
      });

      await blueprints.search({ query: "deploy docker" });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/search",
        expect.objectContaining({
          query: "deploy docker",
        })
      );
    });

    it("should convert camelCase params to snake_case", async () => {
      mockHttp.post.mockResolvedValueOnce({
        results: [],
        total_found: 0,
        query: "test",
      });

      await blueprints.search({
        query: "test",
        minSuccessRate: 0.8,
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/search",
        expect.objectContaining({
          min_success_rate: 0.8,
        })
      );
    });

    it("should convert snake_case response to camelCase", async () => {
      mockHttp.post.mockResolvedValueOnce({
        results: [
          {
            slug: "test",
            title: "Test",
            goal_description: "Test goal",
            similarity_score: 0.95,
            quality_metrics: {
              execution_count: 10,
              success_rate: 0.9,
            },
          },
        ],
        total_found: 1,
        query: "test",
      });

      const result = await blueprints.search({ query: "test" });

      expect(result.totalFound).toBe(1);
      expect(result.results[0].goalDescription).toBe("Test goal");
      expect(result.results[0].similarityScore).toBe(0.95);
      expect(result.results[0].qualityMetrics.executionCount).toBe(10);
    });
  });

  describe("get", () => {
    it("should call GET /api/v1/blueprints/:slug", async () => {
      mockHttp.get.mockResolvedValueOnce({
        id: "123",
        slug: "docker-aws",
        title: "Deploy Docker to AWS",
        goal_description: "Deploy a Docker container",
        status: "published",
      });

      await blueprints.get("docker-aws");

      expect(mockHttp.get).toHaveBeenCalledWith("/api/v1/blueprints/docker-aws");
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce({
        id: "123",
        slug: "docker-aws",
        title: "Deploy Docker to AWS",
        goal_description: "Deploy a Docker container",
        current_version: 1,
        is_public: true,
        execution_steps: [
          {
            order: 1,
            title: "Install CLI",
            action_type: "command",
          },
        ],
      });

      const result = await blueprints.get("docker-aws");

      expect(result.goalDescription).toBe("Deploy a Docker container");
      expect(result.currentVersion).toBe(1);
      expect(result.isPublic).toBe(true);
      expect(result.executionSteps?.[0].actionType).toBe("command");
    });
  });

  describe("list", () => {
    it("should call GET /api/v1/blueprints", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await blueprints.list();

      expect(mockHttp.get).toHaveBeenCalledWith("/api/v1/blueprints", {});
    });

    it("should pass limit and status params", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await blueprints.list({ limit: 20, status: "published" });

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/blueprints",
        expect.objectContaining({
          limit: 20,
          status: "published",
        })
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce([
        {
          slug: "test",
          title: "Test",
          goal_description: "Goal",
          quality_metrics: {
            execution_count: 5,
          },
        },
      ]);

      const result = await blueprints.list();

      expect(result[0].goalDescription).toBe("Goal");
      expect(result[0].qualityMetrics.executionCount).toBe(5);
    });
  });

  describe("create", () => {
    it("should call POST /api/v1/blueprints with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "123",
        slug: "new-blueprint",
        title: "New Blueprint",
        goal_description: "Create something",
      });

      await blueprints.create({
        title: "New Blueprint",
        goalDescription: "Create something",
        strategy: "Use this strategy",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/blueprints",
        expect.objectContaining({
          title: "New Blueprint",
          goal_description: "Create something",
          strategy: "Use this strategy",
        }),
        true
      );
    });

    it("should convert nested arrays to snake_case", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "123",
        slug: "new-blueprint",
      });

      await blueprints.create({
        title: "Test",
        goalDescription: "Test",
        strategy: "Test",
        executionSteps: [
          {
            order: 1,
            title: "Step 1",
            description: "Do something",
            actionType: "command",
          },
        ],
        codeSnippets: [
          {
            language: "bash",
            code: "echo hello",
            order: 1,
          },
        ],
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/blueprints",
        expect.objectContaining({
          execution_steps: [
            expect.objectContaining({
              action_type: "command",
            }),
          ],
          code_snippets: expect.any(Array),
        }),
        true
      );
    });
  });

  describe("update", () => {
    it("should call PUT /api/v1/blueprints/:slug with auth", async () => {
      mockHttp.put.mockResolvedValueOnce({
        id: "123",
        slug: "docker-aws",
        title: "Updated Title",
      });

      await blueprints.update("docker-aws", { title: "Updated Title" });

      expect(mockHttp.put).toHaveBeenCalledWith(
        "/api/v1/blueprints/docker-aws",
        expect.objectContaining({
          title: "Updated Title",
        }),
        true
      );
    });
  });

  describe("similar", () => {
    it("should call GET /api/v1/search/similar/:slug", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await blueprints.similar("docker-aws");

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/search/similar/docker-aws",
        {}
      );
    });

    it("should pass limit param", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await blueprints.similar("docker-aws", { limit: 5 });

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/search/similar/docker-aws",
        expect.objectContaining({
          limit: 5,
        })
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce([
        {
          slug: "similar-bp",
          title: "Similar",
          similarity_score: 0.85,
          goal_description: "Similar goal",
        },
      ]);

      const result = await blueprints.similar("docker-aws");

      expect(result[0].similarityScore).toBe(0.85);
      expect(result[0].goalDescription).toBe("Similar goal");
    });
  });
});
