import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeedbackResource } from "./feedback.js";
import type { HttpClient } from "../http.js";

// Mock HttpClient
const createMockHttpClient = () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
});

describe("FeedbackResource", () => {
  let mockHttp: ReturnType<typeof createMockHttpClient>;
  let feedback: FeedbackResource;

  beforeEach(() => {
    mockHttp = createMockHttpClient();
    feedback = new FeedbackResource(mockHttp as unknown as HttpClient);
  });

  describe("vote", () => {
    it("should call POST /api/v1/feedback/votes with upvote", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Vote recorded" });

      await feedback.vote("docker-aws", "up");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/feedback/votes",
        {
          blueprint_slug: "docker-aws",
          vote_type: "up",
        },
        true
      );
    });

    it("should call POST /api/v1/feedback/votes with downvote", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Vote recorded" });

      await feedback.vote("docker-aws", "down");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/feedback/votes",
        {
          blueprint_slug: "docker-aws",
          vote_type: "down",
        },
        true
      );
    });

    it("should return message from response", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Vote updated" });

      const result = await feedback.vote("docker-aws", "up");

      expect(result.message).toBe("Vote updated");
    });
  });

  describe("reportExecution", () => {
    it("should call POST /api/v1/feedback/executions with success report", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Execution recorded" });

      await feedback.reportExecution({
        blueprintSlug: "docker-aws",
        success: true,
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/feedback/executions",
        expect.objectContaining({
          blueprint_slug: "docker-aws",
          success: true,
        }),
        true
      );
    });

    it("should call POST with failure report and error message", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Execution recorded" });

      await feedback.reportExecution({
        blueprintSlug: "docker-aws",
        success: false,
        errorMessage: "Connection timeout",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/feedback/executions",
        expect.objectContaining({
          blueprint_slug: "docker-aws",
          success: false,
          error_message: "Connection timeout",
        }),
        true
      );
    });

    it("should include execution time when provided", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Execution recorded" });

      await feedback.reportExecution({
        blueprintSlug: "docker-aws",
        success: true,
        executionTimeMs: 5000,
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/feedback/executions",
        expect.objectContaining({
          execution_time_ms: 5000,
        }),
        true
      );
    });

    it("should include context notes when provided", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Execution recorded" });

      await feedback.reportExecution({
        blueprintSlug: "docker-aws",
        success: true,
        contextNotes: "Deployed to us-east-1",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/feedback/executions",
        expect.objectContaining({
          context_notes: "Deployed to us-east-1",
        }),
        true
      );
    });

    it("should return message from response", async () => {
      mockHttp.post.mockResolvedValueOnce({
        message: "Execution report saved",
      });

      const result = await feedback.reportExecution({
        blueprintSlug: "docker-aws",
        success: true,
      });

      expect(result.message).toBe("Execution report saved");
    });
  });
});
