import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionsResource } from "./sessions.js";
import type { HttpClient } from "../http.js";

// Mock HttpClient
const createMockHttpClient = () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
});

describe("SessionsResource", () => {
  let mockHttp: ReturnType<typeof createMockHttpClient>;
  let sessions: SessionsResource;

  beforeEach(() => {
    mockHttp = createMockHttpClient();
    sessions = new SessionsResource(mockHttp as unknown as HttpClient);
  });

  describe("open", () => {
    it("should call POST /api/v1/sessions with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "sess-123",
        short_id: "abc12345",
        status: "active",
        message: "Session opened",
      });

      await sessions.open({ topic: "deploy docker to AWS" });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/sessions",
        expect.objectContaining({
          topic: "deploy docker to AWS",
        }),
        true
      );
    });

    it("should convert camelCase params to snake_case", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "sess-123",
        short_id: "abc12345",
        status: "active",
      });

      await sessions.open({
        topic: "test",
        toolsUsed: ["bash", "git"],
        visibility: "public",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/sessions",
        expect.objectContaining({
          topic: "test",
          tools_used: ["bash", "git"],
          visibility: "public",
        }),
        true
      );
    });

    it("should convert snake_case response to camelCase", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "sess-123",
        short_id: "abc12345",
        status: "active",
        message: "Session opened",
      });

      const result = await sessions.open({ topic: "test" });

      expect(result.shortId).toBe("abc12345");
    });
  });

  describe("get", () => {
    it("should call GET /api/v1/sessions/:identifier with auth", async () => {
      mockHttp.get.mockResolvedValueOnce({
        id: "sess-123",
        short_id: "abc12345",
        topic: "Deploy Docker",
        status: "active",
        tools_used: ["bash"],
      });

      await sessions.get("abc12345");

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/sessions/abc12345",
        undefined,
        true
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce({
        id: "sess-123",
        short_id: "abc12345",
        topic: "Deploy Docker",
        status: "active",
        tools_used: ["bash"],
        agent_id: "agent-1",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      });

      const result = await sessions.get("abc12345");

      expect(result.shortId).toBe("abc12345");
      expect(result.toolsUsed).toEqual(["bash"]);
      expect(result.agentId).toBe("agent-1");
    });
  });

  describe("list", () => {
    it("should call GET /api/v1/sessions with auth", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await sessions.list();

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/sessions",
        undefined,
        true
      );
    });

    it("should pass filtering params", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await sessions.list({ status: "active", limit: 10 });

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/sessions",
        expect.objectContaining({
          status: "active",
          limit: 10,
        }),
        true
      );
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce([
        {
          id: "sess-1",
          short_id: "abc12345",
          topic: "Test",
          status: "active",
          tools_used: [],
          entry_count: 5,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ]);

      const result = await sessions.list();

      expect(result[0].shortId).toBe("abc12345");
      expect(result[0].entryCount).toBe(5);
    });
  });

  describe("logEntry", () => {
    it("should call POST /api/v1/sessions/:id/entries with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Entry logged" });

      await sessions.logEntry("sess-123", {
        entryType: "observation",
        content: { text: "Found an issue" },
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/sessions/sess-123/entries",
        expect.objectContaining({
          entry_type: "observation",
          content: { text: "Found an issue" },
        }),
        true
      );
    });
  });

  describe("close", () => {
    it("should call POST /api/v1/sessions/:id/close with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Session closed" });

      await sessions.close("sess-123", { outcome: "Successfully deployed" });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/sessions/sess-123/close",
        expect.objectContaining({
          outcome: "Successfully deployed",
        }),
        true
      );
    });

    it("should allow close without data", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Session closed" });

      await sessions.close("sess-123");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/sessions/sess-123/close",
        undefined,
        true
      );
    });
  });

  describe("abandon", () => {
    it("should call POST /api/v1/sessions/:id/abandon with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Session abandoned" });

      await sessions.abandon("sess-123");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/sessions/sess-123/abandon",
        undefined,
        true
      );
    });
  });

  describe("contribute", () => {
    it("should call POST /api/v1/sessions/:id/contributions with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ message: "Contribution added" });

      await sessions.contribute("sess-123", {
        content: { suggestion: "Try using Docker Compose" },
        contributionType: "suggestion",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/sessions/sess-123/contributions",
        expect.objectContaining({
          content: { suggestion: "Try using Docker Compose" },
          contribution_type: "suggestion",
        }),
        true
      );
    });
  });

  describe("listContributions", () => {
    it("should call GET /api/v1/sessions/:id/contributions with auth", async () => {
      mockHttp.get.mockResolvedValueOnce([]);

      await sessions.listContributions("sess-123");

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/sessions/sess-123/contributions",
        undefined,
        true
      );
    });
  });
});
