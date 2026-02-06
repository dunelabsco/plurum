import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExperiencesResource } from "./experiences.js";
import type { HttpClient } from "../http.js";

// Mock HttpClient
const createMockHttpClient = () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
});

describe("ExperiencesResource", () => {
  let mockHttp: ReturnType<typeof createMockHttpClient>;
  let experiences: ExperiencesResource;

  beforeEach(() => {
    mockHttp = createMockHttpClient();
    experiences = new ExperiencesResource(mockHttp as unknown as HttpClient);
  });

  describe("create", () => {
    it("should call POST /api/v1/experiences with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "exp-123",
        short_id: "xyz98765",
        slug: "deploy-docker-aws",
        title: "Deploy Docker to AWS",
        goal: "Deploy a Docker container to AWS ECS",
      });

      await experiences.create({
        title: "Deploy Docker to AWS",
        goal: "Deploy a Docker container to AWS ECS",
        domain: "devops",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences",
        expect.objectContaining({
          title: "Deploy Docker to AWS",
          goal: "Deploy a Docker container to AWS ECS",
          domain: "devops",
        }),
        true
      );
    });

    it("should convert nested arrays to snake_case", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "exp-123",
        short_id: "xyz98765",
        slug: "test-exp",
      });

      await experiences.create({
        title: "Test",
        goal: "Test goal",
        deadEnds: [
          { approach: "Tried X", reason: "It failed", timeWasted: "1h" },
        ],
        breakthroughs: [
          { insight: "Use Y instead", trigger: "docs", impact: 4 },
        ],
        toolsUsed: ["bash", "docker"],
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences",
        expect.objectContaining({
          dead_ends: [
            expect.objectContaining({
              approach: "Tried X",
              reason: "It failed",
              time_wasted: "1h",
            }),
          ],
          breakthroughs: [
            expect.objectContaining({
              insight: "Use Y instead",
            }),
          ],
          tools_used: ["bash", "docker"],
        }),
        true
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "exp-123",
        short_id: "xyz98765",
        slug: "deploy-docker-aws",
        title: "Deploy Docker to AWS",
        goal: "Deploy a Docker container",
        quality_score: 85,
        acquire_count: 0,
        created_at: "2024-01-01T00:00:00Z",
      });

      const result = await experiences.create({
        title: "Deploy Docker to AWS",
        goal: "Deploy a Docker container",
      });

      expect(result.shortId).toBe("xyz98765");
      expect(result.qualityScore).toBe(85);
      expect(result.acquireCount).toBe(0);
    });
  });

  describe("get", () => {
    it("should call GET /api/v1/experiences/:identifier", async () => {
      mockHttp.get.mockResolvedValueOnce({
        id: "exp-123",
        short_id: "xyz98765",
        slug: "deploy-docker-aws",
        title: "Deploy Docker to AWS",
        goal: "Deploy a Docker container",
      });

      await experiences.get("deploy-docker-aws");

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws"
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce({
        id: "exp-123",
        short_id: "xyz98765",
        slug: "deploy-docker-aws",
        title: "Deploy Docker to AWS",
        goal: "Deploy a Docker container",
        quality_score: 90,
        dead_ends: [
          { approach: "Manual deploy", reason: "Too slow" },
        ],
        tools_used: ["docker", "aws-cli"],
        agent_id: "agent-1",
        session_id: "sess-1",
        published_at: "2024-01-02T00:00:00Z",
      });

      const result = await experiences.get("deploy-docker-aws");

      expect(result.qualityScore).toBe(90);
      expect(result.deadEnds[0].approach).toBe("Manual deploy");
      expect(result.toolsUsed).toEqual(["docker", "aws-cli"]);
      expect(result.agentId).toBe("agent-1");
      expect(result.sessionId).toBe("sess-1");
      expect(result.publishedAt).toBe("2024-01-02T00:00:00Z");
    });
  });

  describe("list", () => {
    it("should call GET /api/v1/experiences", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await experiences.list();

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/experiences",
        undefined
      );
    });

    it("should pass filtering params", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await experiences.list({ status: "published", domain: "devops", limit: 20 });

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/experiences",
        expect.objectContaining({
          status: "published",
          domain: "devops",
          limit: 20,
        })
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce([
        {
          id: "exp-1",
          short_id: "abc12345",
          slug: "test-exp",
          title: "Test",
          goal: "Test goal",
          quality_score: 75,
          acquire_count: 3,
          tools_used: ["bash"],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ]);

      const result = await experiences.list();

      expect(result[0].shortId).toBe("abc12345");
      expect(result[0].qualityScore).toBe(75);
      expect(result[0].acquireCount).toBe(3);
    });
  });

  describe("search", () => {
    it("should call POST /api/v1/experiences/search", async () => {
      mockHttp.post.mockResolvedValueOnce({
        results: [],
        total_found: 0,
        query: "docker",
      });

      await experiences.search({ query: "deploy docker" });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/search",
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

      await experiences.search({
        query: "test",
        minQuality: 80,
        domain: "devops",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/search",
        expect.objectContaining({
          query: "test",
          min_quality: 80,
          domain: "devops",
        })
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.post.mockResolvedValueOnce({
        results: [
          {
            short_id: "abc12345",
            title: "Docker Deploy",
            quality_score: 90,
            similarity_score: 0.95,
          },
        ],
        total_found: 1,
        query: "docker",
      });

      const result = await experiences.search({ query: "docker" });

      expect(result.totalFound).toBe(1);
      expect(result.results[0].qualityScore).toBe(90);
      expect(result.results[0].similarityScore).toBe(0.95);
    });
  });

  describe("acquire", () => {
    it("should call POST /api/v1/experiences/:identifier/acquire with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({
        experience_id: "exp-123",
        acquired_at: "2024-01-01T00:00:00Z",
        mode: "reference",
        message: "Experience acquired",
      });

      await experiences.acquire("deploy-docker-aws");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/acquire",
        undefined,
        true
      );
    });

    it("should pass mode parameter", async () => {
      mockHttp.post.mockResolvedValueOnce({
        experience_id: "exp-123",
        acquired_at: "2024-01-01T00:00:00Z",
        mode: "copy",
        message: "Experience acquired",
      });

      await experiences.acquire("deploy-docker-aws", { mode: "copy" });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/acquire",
        expect.objectContaining({ mode: "copy" }),
        true
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.post.mockResolvedValueOnce({
        experience_id: "exp-123",
        acquired_at: "2024-01-01T00:00:00Z",
        mode: "reference",
        message: "Experience acquired",
      });

      const result = await experiences.acquire("deploy-docker-aws");

      expect(result.experienceId).toBe("exp-123");
      expect(result.acquiredAt).toBe("2024-01-01T00:00:00Z");
    });
  });

  describe("publish", () => {
    it("should call POST /api/v1/experiences/:identifier/publish with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Experience published" });

      await experiences.publish("deploy-docker-aws");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/publish",
        undefined,
        true
      );
    });
  });

  describe("reportOutcome", () => {
    it("should call POST /api/v1/experiences/:identifier/outcomes with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Outcome recorded" });

      await experiences.reportOutcome("deploy-docker-aws", {
        success: true,
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/outcomes",
        expect.objectContaining({
          success: true,
        }),
        true
      );
    });

    it("should include error message on failure", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Outcome recorded" });

      await experiences.reportOutcome("deploy-docker-aws", {
        success: false,
        errorMessage: "Connection timeout",
        contextNotes: "Tried in us-east-1",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/outcomes",
        expect.objectContaining({
          success: false,
          error_message: "Connection timeout",
          context_notes: "Tried in us-east-1",
        }),
        true
      );
    });
  });

  describe("vote", () => {
    it("should call POST /api/v1/experiences/:identifier/votes with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Vote recorded" });

      await experiences.vote("deploy-docker-aws", { voteType: "up" });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/votes",
        expect.objectContaining({
          vote_type: "up",
        }),
        true
      );
    });

    it("should handle downvote", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Vote recorded" });

      await experiences.vote("deploy-docker-aws", { voteType: "down" });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/votes",
        expect.objectContaining({
          vote_type: "down",
        }),
        true
      );
    });
  });

  describe("findSimilar", () => {
    it("should call GET /api/v1/experiences/:identifier/similar", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await experiences.findSimilar("deploy-docker-aws");

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/similar",
        undefined
      );
    });

    it("should pass limit param", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await experiences.findSimilar("deploy-docker-aws", 5);

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/experiences/deploy-docker-aws/similar",
        expect.objectContaining({
          limit: 5,
        })
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce([
        {
          short_id: "abc12345",
          slug: "similar-exp",
          title: "Similar Experience",
          similarity_score: 0.85,
          quality_score: 80,
        },
      ]);

      const result = await experiences.findSimilar("deploy-docker-aws");

      expect(result[0].similarityScore).toBe(0.85);
      expect(result[0].qualityScore).toBe(80);
    });
  });
});
