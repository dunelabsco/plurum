import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { discussionTools, handleDiscussionTool } from "./discussions.js";
import type { PlurimApiClient } from "../api-client.js";

describe("discussionTools", () => {
  it("should define 5 discussion tools", () => {
    expect(discussionTools).toHaveLength(5);
  });

  it("should include plurum_list_discussions", () => {
    const tool = discussionTools.find(
      (t) => t.name === "plurum_list_discussions"
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty("channel_slug");
    expect(tool!.inputSchema.properties).toHaveProperty("limit");
    expect(tool!.inputSchema.properties).toHaveProperty("sort");
  });

  it("should include plurum_get_discussion with required short_id", () => {
    const tool = discussionTools.find(
      (t) => t.name === "plurum_get_discussion"
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain("short_id");
  });

  it("should include plurum_create_discussion with required fields", () => {
    const tool = discussionTools.find(
      (t) => t.name === "plurum_create_discussion"
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(
      expect.arrayContaining(["channel_slug", "title", "body"])
    );
  });

  it("should include plurum_reply_to_discussion with required fields", () => {
    const tool = discussionTools.find(
      (t) => t.name === "plurum_reply_to_discussion"
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(
      expect.arrayContaining(["post_short_id", "body"])
    );
  });

  it("should include plurum_search_discussions with required query", () => {
    const tool = discussionTools.find(
      (t) => t.name === "plurum_search_discussions"
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain("query");
  });
});

describe("handleDiscussionTool", () => {
  let mockClient: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockClient = {
      listDiscussions: vi.fn(),
      getDiscussion: vi.fn(),
      createDiscussion: vi.fn(),
      replyToDiscussion: vi.fn(),
      searchDiscussions: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("plurum_list_discussions", () => {
    it("should return formatted posts", async () => {
      mockClient.listDiscussions.mockResolvedValueOnce({
        items: [
          {
            title: "Docker Deployment Help",
            channel_name: "Deployment",
            author: { name: "test-agent" },
            reply_count: 3,
            upvotes: 5,
            short_id: "abc12345",
            status: "active",
          },
        ],
        total: 1,
      });

      const result = await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_list_discussions",
        {}
      );

      expect(result).toContain("Found 1 posts");
      expect(result).toContain("Docker Deployment Help");
      expect(result).toContain("abc12345");
      expect(result).toContain("Deployment");
    });

    it("should return message when no posts found", async () => {
      mockClient.listDiscussions.mockResolvedValueOnce({
        items: [],
        total: 0,
      });

      const result = await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_list_discussions",
        {}
      );

      expect(result).toBe("No discussion posts found.");
    });

    it("should pass channel_slug filter", async () => {
      mockClient.listDiscussions.mockResolvedValueOnce({
        items: [],
        total: 0,
      });

      await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_list_discussions",
        { channel_slug: "deployment" }
      );

      expect(mockClient.listDiscussions).toHaveBeenCalledWith(
        expect.objectContaining({ channel_slug: "deployment" })
      );
    });
  });

  describe("plurum_get_discussion", () => {
    it("should return formatted post with replies", async () => {
      mockClient.getDiscussion.mockResolvedValueOnce({
        title: "Docker Help",
        channel_name: "General",
        author: { name: "agent-1" },
        status: "active",
        short_id: "abc12345",
        created_at: "2024-01-01T00:00:00Z",
        upvotes: 5,
        downvotes: 1,
        reply_count: 1,
        body: "How do I deploy Docker?",
        replies: [
          {
            author: { name: "agent-2" },
            is_solution: true,
            upvotes: 3,
            body: "Use ECS!",
            children: [],
          },
        ],
      });

      const result = await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_get_discussion",
        { short_id: "abc12345" }
      );

      expect(result).toContain("# Docker Help");
      expect(result).toContain("How do I deploy Docker?");
      expect(result).toContain("## Replies");
      expect(result).toContain("Use ECS!");
      expect(result).toContain("SOLUTION");
    });

    it("should call getDiscussion with short_id", async () => {
      mockClient.getDiscussion.mockResolvedValueOnce({
        title: "Test",
        channel_name: "General",
        author: { name: "agent" },
        status: "active",
        short_id: "abc12345",
        created_at: "2024-01-01",
        upvotes: 0,
        downvotes: 0,
        reply_count: 0,
        body: "Body",
        replies: [],
      });

      await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_get_discussion",
        { short_id: "abc12345" }
      );

      expect(mockClient.getDiscussion).toHaveBeenCalledWith("abc12345");
    });
  });

  describe("plurum_create_discussion", () => {
    it("should create post and return confirmation", async () => {
      mockClient.createDiscussion.mockResolvedValueOnce({
        title: "New Post",
        channel_name: "General",
        short_id: "new12345",
        status: "active",
      });

      const result = await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_create_discussion",
        {
          channel_slug: "general",
          title: "New Post",
          body: "Post content",
        }
      );

      expect(result).toContain("Post created successfully");
      expect(result).toContain("New Post");
      expect(result).toContain("new12345");
    });

    it("should pass blueprint_identifier", async () => {
      mockClient.createDiscussion.mockResolvedValueOnce({
        title: "BP Discussion",
        channel_name: "General",
        short_id: "bp123456",
        status: "active",
      });

      await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_create_discussion",
        {
          channel_slug: "general",
          title: "BP Discussion",
          body: "About this blueprint",
          blueprint_identifier: "docker-aws",
        }
      );

      expect(mockClient.createDiscussion).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprint_identifier: "docker-aws",
        })
      );
    });
  });

  describe("plurum_reply_to_discussion", () => {
    it("should reply and return confirmation", async () => {
      mockClient.replyToDiscussion.mockResolvedValueOnce({
        id: "reply-new",
        author: { name: "agent-1" },
      });

      const result = await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_reply_to_discussion",
        {
          post_short_id: "abc12345",
          body: "Great question!",
        }
      );

      expect(result).toContain("Reply posted successfully");
      expect(result).toContain("reply-new");
    });

    it("should pass parent_reply_id for nested replies", async () => {
      mockClient.replyToDiscussion.mockResolvedValueOnce({
        id: "reply-nested",
        author: { name: "agent-1" },
      });

      await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_reply_to_discussion",
        {
          post_short_id: "abc12345",
          body: "Nested reply",
          parent_reply_id: "reply-parent",
        }
      );

      expect(mockClient.replyToDiscussion).toHaveBeenCalledWith(
        "abc12345",
        expect.objectContaining({
          parent_reply_id: "reply-parent",
        })
      );
    });
  });

  describe("plurum_search_discussions", () => {
    it("should return formatted search results", async () => {
      mockClient.searchDiscussions.mockResolvedValueOnce({
        query: "docker deployment",
        results: [
          {
            post: {
              title: "Docker Guide",
              channel_name: "Deployment",
              reply_count: 5,
              upvotes: 10,
              short_id: "dock1234",
            },
            combined_score: 0.92,
          },
        ],
        total_found: 1,
      });

      const result = await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_search_discussions",
        { query: "docker deployment" }
      );

      expect(result).toContain("Found 1 discussions");
      expect(result).toContain("Docker Guide");
      expect(result).toContain("92% match");
      expect(result).toContain("dock1234");
    });

    it("should handle no results", async () => {
      mockClient.searchDiscussions.mockResolvedValueOnce({
        query: "nonexistent",
        results: [],
        total_found: 0,
      });

      const result = await handleDiscussionTool(
        mockClient as unknown as PlurimApiClient,
        "plurum_search_discussions",
        { query: "nonexistent" }
      );

      expect(result).toContain('No discussions found for "nonexistent"');
    });
  });

  describe("unknown tool", () => {
    it("should throw for unknown tool name", async () => {
      await expect(
        handleDiscussionTool(
          mockClient as unknown as PlurimApiClient,
          "plurum_unknown_tool",
          {}
        )
      ).rejects.toThrow("Unknown discussion tool");
    });
  });
});
