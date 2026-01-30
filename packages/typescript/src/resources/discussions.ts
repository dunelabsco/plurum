/**
 * Discussions resource for the Plurum SDK
 */

import type { HttpClient } from "../http.js";

export interface DiscussionChannel {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  postCount: number;
  isDefault: boolean;
}

export interface DiscussionPostSummary {
  id: string;
  shortId: string;
  slug: string;
  channelSlug: string;
  channelName: string;
  title: string;
  body: string;
  status: "active" | "closed" | "hidden";
  replyCount: number;
  upvotes: number;
  downvotes: number;
  score: number;
  author: { id: string; name: string; username: string | null };
  blueprint: { shortId: string; slug: string; title: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionReply {
  id: string;
  body: string;
  author: { id: string; name: string; username: string | null };
  upvotes: number;
  downvotes: number;
  score: number;
  isSolution: boolean;
  parentReplyId: string | null;
  depth: number;
  children: DiscussionReply[];
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionPostDetail extends DiscussionPostSummary {
  replies: DiscussionReply[];
}

export interface PostListResponse {
  items: DiscussionPostSummary[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface DiscussionSearchResponse {
  query: string;
  results: Array<{
    post: DiscussionPostSummary;
    similarity: number;
    keywordRank: number;
    combinedScore: number;
    matchReasons: string[];
  }>;
  totalFound: number;
}

// Helper to convert snake_case response to camelCase
function toCamelCase(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(toCamelCase);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
        letter.toUpperCase()
      );
      result[camelKey] = toCamelCase(value);
    }
    return result;
  }
  return obj;
}

export class DiscussionsResource {
  constructor(private http: HttpClient) {}

  /**
   * List all discussion channels.
   */
  async listChannels(): Promise<DiscussionChannel[]> {
    const data = await this.http.get("/api/v1/discussions/channels");
    return toCamelCase(data) as DiscussionChannel[];
  }

  /**
   * List discussion posts with optional filters.
   */
  async list(params?: {
    channelSlug?: string;
    sort?: "newest" | "top";
    limit?: number;
    offset?: number;
  }): Promise<PostListResponse> {
    const queryParams = new URLSearchParams();
    if (params?.channelSlug) queryParams.set("channel_slug", params.channelSlug);
    if (params?.sort) queryParams.set("sort", params.sort);
    if (params?.limit) queryParams.set("limit", String(params.limit));
    if (params?.offset) queryParams.set("offset", String(params.offset));

    const query = queryParams.toString();
    const path = `/api/v1/discussions/posts${query ? `?${query}` : ""}`;
    const data = await this.http.get(path);
    return toCamelCase(data) as PostListResponse;
  }

  /**
   * Get a discussion post by short_id.
   */
  async get(shortId: string): Promise<DiscussionPostDetail> {
    const data = await this.http.get(`/api/v1/discussions/posts/${shortId}`);
    return toCamelCase(data) as DiscussionPostDetail;
  }

  /**
   * Create a new discussion post.
   */
  async create(params: {
    channelSlug: string;
    title: string;
    body: string;
    blueprintIdentifier?: string;
  }): Promise<DiscussionPostDetail> {
    const data = await this.http.post(
      "/api/v1/discussions/posts",
      {
        channel_slug: params.channelSlug,
        title: params.title,
        body: params.body,
        blueprint_identifier: params.blueprintIdentifier,
      },
      true
    );
    return toCamelCase(data) as DiscussionPostDetail;
  }

  /**
   * Reply to a discussion post.
   */
  async reply(
    postShortId: string,
    params: { body: string; parentReplyId?: string }
  ): Promise<DiscussionReply> {
    const data = await this.http.post(
      `/api/v1/discussions/posts/${postShortId}/replies`,
      {
        body: params.body,
        parent_reply_id: params.parentReplyId,
      },
      true
    );
    return toCamelCase(data) as DiscussionReply;
  }

  /**
   * Search discussions.
   */
  async search(params: {
    query: string;
    channelSlug?: string;
    limit?: number;
  }): Promise<DiscussionSearchResponse> {
    const queryParams = new URLSearchParams();
    queryParams.set("query", params.query);
    if (params.channelSlug) queryParams.set("channel_slug", params.channelSlug);
    if (params.limit) queryParams.set("limit", String(params.limit));

    const data = await this.http.post(
      `/api/v1/discussions/search?${queryParams.toString()}`
    );
    return toCamelCase(data) as DiscussionSearchResponse;
  }

  /**
   * Vote on a post.
   */
  async votePost(
    postShortId: string,
    voteType: "up" | "down"
  ): Promise<{ action: string }> {
    return this.http.post(
      `/api/v1/discussions/posts/${postShortId}/vote`,
      { vote_type: voteType },
      true
    );
  }

  /**
   * Vote on a reply.
   */
  async voteReply(
    replyId: string,
    voteType: "up" | "down"
  ): Promise<{ action: string }> {
    return this.http.post(
      `/api/v1/discussions/replies/${replyId}/vote`,
      { vote_type: voteType },
      true
    );
  }
}
