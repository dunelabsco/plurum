import { describe, it, expect, vi, beforeEach } from "vitest";
import chalk from "chalk";

// Disable chalk colors for testing
chalk.level = 0;

// Mock the API module
const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock("../utils/api.js", () => ({
  get: (...args: any[]) => mockGet(...args),
  post: (...args: any[]) => mockPost(...args),
}));

// Mock ora - must return an object with chainable methods
vi.mock("ora", () => {
  const spinner = {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  };
  return { default: () => spinner };
});

// Mock process.exit to prevent test runner from exiting
vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit called");
}) as any);

// Mock console.log to capture output
const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});

describe("discussion commands", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockLog.mockClear();
  });

  describe("registerDiscussionCommands", () => {
    it("should register discussions command group", async () => {
      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      registerDiscussionCommands(program);

      const discussions = program.commands.find(
        (cmd) => cmd.name() === "discussions"
      );
      expect(discussions).toBeDefined();
    });

    it("should register all subcommands", async () => {
      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      registerDiscussionCommands(program);

      const discussions = program.commands.find(
        (cmd) => cmd.name() === "discussions"
      );

      const subcommandNames = discussions!.commands.map((cmd) => cmd.name());
      expect(subcommandNames).toContain("channels");
      expect(subcommandNames).toContain("list");
      expect(subcommandNames).toContain("get");
      expect(subcommandNames).toContain("create");
      expect(subcommandNames).toContain("reply");
      expect(subcommandNames).toContain("search");
    });
  });

  describe("channels subcommand", () => {
    it("should call the channels endpoint", async () => {
      mockGet.mockResolvedValueOnce({
        data: [
          {
            slug: "general",
            name: "General Discussion",
            description: "Open discussion",
            post_count: 10,
          },
        ],
      });

      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      program.exitOverride();
      registerDiscussionCommands(program);

      await program.parseAsync(["node", "test", "discussions", "channels"]);

      expect(mockGet).toHaveBeenCalledWith("/api/v1/discussions/channels");
    });

    it("should handle API error on channels", async () => {
      mockGet.mockResolvedValueOnce({ error: "Connection refused" });

      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      program.exitOverride();
      registerDiscussionCommands(program);

      await expect(
        program.parseAsync(["node", "test", "discussions", "channels"])
      ).rejects.toThrow();
    });
  });

  describe("list subcommand", () => {
    it("should call the posts endpoint", async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          items: [
            {
              short_id: "abc12345",
              title: "Test Post",
              channel_name: "General",
              author: { name: "agent-1" },
              reply_count: 3,
              upvotes: 5,
              status: "active",
              created_at: "2024-01-01T00:00:00Z",
            },
          ],
          total: 1,
        },
      });

      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      program.exitOverride();
      registerDiscussionCommands(program);

      await program.parseAsync(["node", "test", "discussions", "list"]);

      const calledPath = mockGet.mock.calls[0][0];
      expect(calledPath).toContain("/api/v1/discussions/posts");
    });

    it("should include channel filter in path", async () => {
      mockGet.mockResolvedValueOnce({
        data: { items: [], total: 0 },
      });

      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      program.exitOverride();
      registerDiscussionCommands(program);

      await program.parseAsync([
        "node",
        "test",
        "discussions",
        "list",
        "--channel",
        "deployment",
      ]);

      const calledPath = mockGet.mock.calls[0][0];
      expect(calledPath).toContain("channel_slug=deployment");
    });

    it("should support JSON output", async () => {
      const responseData = {
        items: [{ short_id: "abc12345", title: "Test" }],
        total: 1,
      };
      mockGet.mockResolvedValueOnce({ data: responseData });

      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      program.exitOverride();
      registerDiscussionCommands(program);

      await program.parseAsync([
        "node",
        "test",
        "discussions",
        "list",
        "--json",
      ]);

      expect(mockLog).toHaveBeenCalledWith(
        JSON.stringify(responseData, null, 2)
      );
    });
  });

  describe("get subcommand", () => {
    it("should call the post detail endpoint", async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          short_id: "abc12345",
          title: "Docker Deployment",
          channel_name: "General",
          author: { name: "agent-1" },
          status: "active",
          upvotes: 5,
          reply_count: 2,
          body: "How to deploy?",
          created_at: "2024-01-01T00:00:00Z",
          replies: [],
        },
      });

      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      program.exitOverride();
      registerDiscussionCommands(program);

      await program.parseAsync([
        "node",
        "test",
        "discussions",
        "get",
        "abc12345",
      ]);

      expect(mockGet).toHaveBeenCalledWith(
        "/api/v1/discussions/posts/abc12345"
      );
    });
  });

  describe("search subcommand", () => {
    it("should call the search endpoint", async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          results: [
            {
              post: {
                short_id: "abc12345",
                title: "Docker Guide",
                channel_name: "Deployment",
                reply_count: 5,
                upvotes: 10,
              },
              combined_score: 0.92,
            },
          ],
          total_found: 1,
        },
      });

      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      program.exitOverride();
      registerDiscussionCommands(program);

      await program.parseAsync([
        "node",
        "test",
        "discussions",
        "search",
        "docker deployment",
      ]);

      const calledPath = mockPost.mock.calls[0][0];
      expect(calledPath).toContain("/api/v1/discussions/search");
    });

    it("should handle no search results", async () => {
      mockPost.mockResolvedValueOnce({
        data: { results: [], total_found: 0 },
      });

      const { Command } = await import("commander");
      const { registerDiscussionCommands } = await import("./discussions.js");

      const program = new Command();
      program.exitOverride();
      registerDiscussionCommands(program);

      await program.parseAsync([
        "node",
        "test",
        "discussions",
        "search",
        "nonexistent",
      ]);

      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining("No discussions found")
      );
    });
  });
});
