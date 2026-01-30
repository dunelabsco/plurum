import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchTools, handleSearchTool } from "./search.js";
import type { PlurimApiClient } from "../api-client.js";

describe("searchTools", () => {
  it("should define plurum_search tool", () => {
    const searchTool = searchTools.find((t) => t.name === "plurum_search");
    expect(searchTool).toBeDefined();
    expect(searchTool?.description).toContain("Search for blueprints");
    expect(searchTool?.inputSchema.required).toContain("query");
  });

  it("should define plurum_similar tool", () => {
    const similarTool = searchTools.find((t) => t.name === "plurum_similar");
    expect(similarTool).toBeDefined();
    expect(similarTool?.description).toContain("similar");
    expect(similarTool?.inputSchema.required).toContain("slug");
  });

  it("should have correct schema for plurum_search", () => {
    const tool = searchTools.find((t) => t.name === "plurum_search")!;
    const props = tool.inputSchema.properties as Record<string, unknown>;

    expect(props.query).toBeDefined();
    expect(props.tags).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.min_success_rate).toBeDefined();
  });
});

describe("handleSearchTool", () => {
  let mockClient: Partial<PlurimApiClient>;

  beforeEach(() => {
    mockClient = {
      search: vi.fn(),
      getSimilar: vi.fn(),
    };
  });

  describe("plurum_search", () => {
    it("should call client.search with query", async () => {
      (mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        results: [],
        total_found: 0,
        query: "deploy docker",
      });

      await handleSearchTool(
        mockClient as PlurimApiClient,
        "plurum_search",
        { query: "deploy docker" }
      );

      expect(mockClient.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: "deploy docker" })
      );
    });

    it("should return 'no results' message when empty", async () => {
      (mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        results: [],
        total_found: 0,
        query: "test query",
      });

      const result = await handleSearchTool(
        mockClient as PlurimApiClient,
        "plurum_search",
        { query: "test query" }
      );

      expect(result).toContain("No blueprints found");
      expect(result).toContain("test query");
    });

    it("should format results correctly", async () => {
      (mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        results: [
          {
            similarity: 0.95,
            match_reasons: ["title match"],
            blueprint: {
              slug: "docker-aws",
              title: "Deploy Docker to AWS",
              tags: ["docker", "aws"],
              quality_metrics: {
                success_rate: 0.9,
                execution_count: 100,
                score: 4.5,
              },
            },
          },
        ],
        total_found: 1,
        query: "deploy docker",
      });

      const result = await handleSearchTool(
        mockClient as PlurimApiClient,
        "plurum_search",
        { query: "deploy docker" }
      );

      expect(result).toContain("Found 1 blueprints");
      expect(result).toContain("Deploy Docker to AWS");
      expect(result).toContain("docker-aws");
      expect(result).toContain("95%");
      expect(result).toContain("90%");
      expect(result).toContain("docker, aws");
    });

    it("should pass tags and limit to client", async () => {
      (mockClient.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        results: [],
        total_found: 0,
        query: "test",
      });

      await handleSearchTool(mockClient as PlurimApiClient, "plurum_search", {
        query: "test",
        tags: ["docker", "aws"],
        limit: 5,
        min_success_rate: 0.8,
      });

      expect(mockClient.search).toHaveBeenCalledWith({
        query: "test",
        tags: ["docker", "aws"],
        limit: 5,
        min_success_rate: 0.8,
      });
    });
  });

  describe("plurum_similar", () => {
    it("should call client.getSimilar with slug", async () => {
      (mockClient.getSimilar as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await handleSearchTool(mockClient as PlurimApiClient, "plurum_similar", {
        slug: "docker-aws",
      });

      expect(mockClient.getSimilar).toHaveBeenCalledWith(
        "docker-aws",
        expect.any(Object)
      );
    });

    it("should return 'no similar' message when empty", async () => {
      (mockClient.getSimilar as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const result = await handleSearchTool(
        mockClient as PlurimApiClient,
        "plurum_similar",
        { slug: "docker-aws" }
      );

      expect(result).toContain("No similar blueprints found");
      expect(result).toContain("docker-aws");
    });

    it("should format similar results correctly", async () => {
      (mockClient.getSimilar as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          similarity: 0.85,
          blueprint: {
            slug: "ecs-deployment",
            title: "ECS Deployment",
            tags: ["ecs", "aws"],
            quality_metrics: {
              success_rate: 0.8,
            },
          },
        },
      ]);

      const result = await handleSearchTool(
        mockClient as PlurimApiClient,
        "plurum_similar",
        { slug: "docker-aws" }
      );

      expect(result).toContain("Similar blueprints");
      expect(result).toContain("ECS Deployment");
      expect(result).toContain("ecs-deployment");
      expect(result).toContain("85%");
    });

    it("should pass limit to client", async () => {
      (mockClient.getSimilar as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await handleSearchTool(mockClient as PlurimApiClient, "plurum_similar", {
        slug: "docker-aws",
        limit: 10,
      });

      expect(mockClient.getSimilar).toHaveBeenCalledWith("docker-aws", {
        limit: 10,
      });
    });
  });

  describe("error handling", () => {
    it("should throw on unknown tool name", async () => {
      await expect(
        handleSearchTool(mockClient as PlurimApiClient, "unknown_tool", {})
      ).rejects.toThrow("Unknown search tool: unknown_tool");
    });
  });
});
