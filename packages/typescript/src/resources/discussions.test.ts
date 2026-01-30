import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscussionsResource } from "./discussions.js";
import type { HttpClient } from "../http.js";

// Mock HttpClient
const createMockHttpClient = () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
});

describe("DiscussionsResource", () => {
  let mockHttp: ReturnType<typeof createMockHttpClient>;
  let discussions: DiscussionsResource;

  beforeEach(() => {
    mockHttp = createMockHttpClient();
    discussions = new DiscussionsResource(mockHttp as unknown as HttpClient);
  });

  describe("listChannels", () => {
    it("should call GET /api/v1/discussions/channels", async () => {
      mockHttp.get.mockResolvedValueOnce([
        {
          id: "ch-1",
          slug: "general",
          name: "General Discussion",
          description: "Open discussion",
          icon: "MessageCircle",
          post_count: 10,
          is_default: true,
        },
      ]);

      const result = await discussions.listChannels();

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/discussions/channels"
      );
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe("general");
    });

    it("should convert snake_case to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce([
        {
          id: "ch-1",
          slug: "general",
          name: "General",
          post_count: 5,
          is_default: true,
        },
      ]);

      const result = await discussions.listChannels();

      expect(result[0].postCount).toBe(5);
      expect(result[0].isDefault).toBe(true);
    });
  });

  describe("list", () => {
    it("should call GET /api/v1/discussions/posts with no params", async () => {
      mockHttp.get.mockResolvedValueOnce({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
      });

      await discussions.list();

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/discussions/posts"
      );
    });

    it("should include channel_slug filter in URL", async () => {
      mockHttp.get.mockResolvedValueOnce({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
      });

      await discussions.list({ channelSlug: "deployment" });

      const calledUrl = mockHttp.get.mock.calls[0][0];
      expect(calledUrl).toContain("channel_slug=deployment");
    });

    it("should include sort and limit in URL", async () => {
      mockHttp.get.mockResolvedValueOnce({
        items: [],
        total: 0,
        limit: 10,
        offset: 0,
        has_more: false,
      });

      await discussions.list({ sort: "top", limit: 10 });

      const calledUrl = mockHttp.get.mock.calls[0][0];
      expect(calledUrl).toContain("sort=top");
      expect(calledUrl).toContain("limit=10");
    });

    it("should convert response to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce({
        items: [
          {
            id: "p-1",
            short_id: "abc12345",
            slug: "test-post",
            channel_slug: "general",
            channel_name: "General",
            title: "Test",
            body: "Body text",
            reply_count: 3,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          },
        ],
        total: 1,
        has_more: false,
      });

      const result = await discussions.list();

      expect(result.items[0].shortId).toBe("abc12345");
      expect(result.items[0].channelSlug).toBe("general");
      expect(result.items[0].channelName).toBe("General");
      expect(result.items[0].replyCount).toBe(3);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("get", () => {
    it("should call GET /api/v1/discussions/posts/:shortId", async () => {
      mockHttp.get.mockResolvedValueOnce({
        id: "p-1",
        short_id: "abc12345",
        title: "Test Post",
        body: "Full body",
        reply_count: 2,
        replies: [],
      });

      await discussions.get("abc12345");

      expect(mockHttp.get).toHaveBeenCalledWith(
        "/api/v1/discussions/posts/abc12345"
      );
    });

    it("should convert nested replies to camelCase", async () => {
      mockHttp.get.mockResolvedValueOnce({
        id: "p-1",
        short_id: "abc12345",
        title: "Test Post",
        body: "Full body",
        reply_count: 1,
        replies: [
          {
            id: "r-1",
            body: "A reply",
            is_solution: true,
            parent_reply_id: null,
            created_at: "2024-01-02T00:00:00Z",
            updated_at: "2024-01-02T00:00:00Z",
            children: [],
          },
        ],
      });

      const result = await discussions.get("abc12345");

      expect(result.replies).toHaveLength(1);
      expect(result.replies[0].isSolution).toBe(true);
      expect(result.replies[0].parentReplyId).toBeNull();
    });
  });

  describe("create", () => {
    it("should call POST /api/v1/discussions/posts with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "p-new",
        short_id: "xyz98765",
        title: "New Discussion",
        body: "Content here",
        channel_name: "General",
      });

      await discussions.create({
        channelSlug: "general",
        title: "New Discussion",
        body: "Content here",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/discussions/posts",
        {
          channel_slug: "general",
          title: "New Discussion",
          body: "Content here",
          blueprint_identifier: undefined,
        },
        true
      );
    });

    it("should include blueprint_identifier when provided", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "p-new",
        short_id: "xyz98765",
        title: "Discussion about BP",
      });

      await discussions.create({
        channelSlug: "general",
        title: "Discussion about BP",
        body: "Linked to a blueprint",
        blueprintIdentifier: "docker-aws",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/discussions/posts",
        expect.objectContaining({
          blueprint_identifier: "docker-aws",
        }),
        true
      );
    });
  });

  describe("reply", () => {
    it("should call POST /api/v1/discussions/posts/:shortId/replies with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "r-new",
        body: "My reply",
        depth: 0,
      });

      await discussions.reply("abc12345", { body: "My reply" });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/discussions/posts/abc12345/replies",
        {
          body: "My reply",
          parent_reply_id: undefined,
        },
        true
      );
    });

    it("should include parent_reply_id for nested replies", async () => {
      mockHttp.post.mockResolvedValueOnce({
        id: "r-nested",
        body: "Nested reply",
        depth: 1,
        parent_reply_id: "r-parent",
      });

      await discussions.reply("abc12345", {
        body: "Nested reply",
        parentReplyId: "r-parent",
      });

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/discussions/posts/abc12345/replies",
        expect.objectContaining({
          parent_reply_id: "r-parent",
        }),
        true
      );
    });
  });

  describe("search", () => {
    it("should call POST /api/v1/discussions/search with query params", async () => {
      mockHttp.post.mockResolvedValueOnce({
        query: "docker deployment",
        results: [],
        total_found: 0,
      });

      await discussions.search({ query: "docker deployment" });

      const calledUrl = mockHttp.post.mock.calls[0][0];
      expect(calledUrl).toContain("/api/v1/discussions/search");
      expect(calledUrl).toContain("query=docker+deployment");
    });

    it("should include channel_slug filter", async () => {
      mockHttp.post.mockResolvedValueOnce({
        query: "test",
        results: [],
        total_found: 0,
      });

      await discussions.search({
        query: "test",
        channelSlug: "deployment",
      });

      const calledUrl = mockHttp.post.mock.calls[0][0];
      expect(calledUrl).toContain("channel_slug=deployment");
    });

    it("should convert response to camelCase", async () => {
      mockHttp.post.mockResolvedValueOnce({
        query: "docker",
        results: [
          {
            post: {
              short_id: "abc12345",
              title: "Docker Guide",
              reply_count: 5,
              channel_name: "Deployment",
            },
            combined_score: 0.92,
            match_reasons: ["title match"],
          },
        ],
        total_found: 1,
      });

      const result = await discussions.search({ query: "docker" });

      expect(result.totalFound).toBe(1);
      expect(result.results[0].combinedScore).toBe(0.92);
      expect(result.results[0].post.shortId).toBe("abc12345");
      expect(result.results[0].post.replyCount).toBe(5);
      expect(result.results[0].matchReasons).toEqual(["title match"]);
    });
  });

  describe("votePost", () => {
    it("should call POST /api/v1/discussions/posts/:shortId/vote with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ action: "created" });

      await discussions.votePost("abc12345", "up");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/discussions/posts/abc12345/vote",
        { vote_type: "up" },
        true
      );
    });

    it("should handle downvote", async () => {
      mockHttp.post.mockResolvedValueOnce({ action: "created" });

      await discussions.votePost("abc12345", "down");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/discussions/posts/abc12345/vote",
        { vote_type: "down" },
        true
      );
    });

    it("should return action from response", async () => {
      mockHttp.post.mockResolvedValueOnce({ action: "removed" });

      const result = await discussions.votePost("abc12345", "up");

      expect(result.action).toBe("removed");
    });
  });

  describe("voteReply", () => {
    it("should call POST /api/v1/discussions/replies/:id/vote with auth", async () => {
      mockHttp.post.mockResolvedValueOnce({ action: "created" });

      await discussions.voteReply("reply-123", "up");

      expect(mockHttp.post).toHaveBeenCalledWith(
        "/api/v1/discussions/replies/reply-123/vote",
        { vote_type: "up" },
        true
      );
    });
  });
});
