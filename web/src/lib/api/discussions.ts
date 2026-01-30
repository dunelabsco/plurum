/**
 * Discussion API endpoints (client-side).
 */

import { apiClient } from "./client";
import type {
  DiscussionChannel,
  DiscussionPostDetail,
  DiscussionPostSummary,
  DiscussionReply,
  PostListResponse,
  PostListParams,
  PostCreateData,
  PostUpdateData,
  ReplyCreateData,
  DiscussionSearchResponse,
} from "@/types/discussion";

/**
 * List all discussion channels.
 */
export async function listChannels(): Promise<DiscussionChannel[]> {
  return apiClient.get<DiscussionChannel[]>("/discussions/channels");
}

/**
 * List discussion posts with optional filters.
 */
export async function listDiscussionPosts(
  params?: PostListParams
): Promise<PostListResponse> {
  const searchParams = new URLSearchParams();

  if (params?.channel_slug) {
    searchParams.set("channel_slug", params.channel_slug);
  }
  if (params?.sort) {
    searchParams.set("sort", params.sort);
  }
  if (params?.limit) {
    searchParams.set("limit", params.limit.toString());
  }
  if (params?.offset) {
    searchParams.set("offset", params.offset.toString());
  }

  const query = searchParams.toString();
  const endpoint = `/discussions/posts${query ? `?${query}` : ""}`;

  return apiClient.get<PostListResponse>(endpoint);
}

/**
 * List recent posts across all channels.
 */
export async function listRecentPosts(
  limit: number = 20
): Promise<DiscussionPostSummary[]> {
  return apiClient.get<DiscussionPostSummary[]>(
    `/discussions/posts/recent?limit=${limit}`
  );
}

/**
 * Get a post by short_id with full details.
 */
export async function getDiscussionPost(
  shortId: string
): Promise<DiscussionPostDetail> {
  return apiClient.get<DiscussionPostDetail>(`/discussions/posts/${shortId}`);
}

/**
 * Create a new discussion post.
 */
export async function createDiscussionPost(
  data: PostCreateData
): Promise<DiscussionPostDetail> {
  return apiClient.post<DiscussionPostDetail>("/discussions/posts", data);
}

/**
 * Update a discussion post.
 */
export async function updateDiscussionPost(
  shortId: string,
  data: PostUpdateData
): Promise<DiscussionPostDetail> {
  return apiClient.put<DiscussionPostDetail>(
    `/discussions/posts/${shortId}`,
    data
  );
}

/**
 * Delete a discussion post.
 */
export async function deleteDiscussionPost(shortId: string): Promise<void> {
  return apiClient.delete<void>(`/discussions/posts/${shortId}`);
}

/**
 * Create a reply to a post.
 */
export async function createReply(
  postShortId: string,
  data: ReplyCreateData
): Promise<DiscussionReply> {
  return apiClient.post<DiscussionReply>(
    `/discussions/posts/${postShortId}/replies`,
    data
  );
}

/**
 * Delete a reply.
 */
export async function deleteReply(replyId: string): Promise<void> {
  return apiClient.delete<void>(`/discussions/replies/${replyId}`);
}

/**
 * Mark a reply as solution.
 */
export async function markSolution(
  replyId: string
): Promise<DiscussionReply> {
  return apiClient.patch<DiscussionReply>(
    `/discussions/replies/${replyId}/solution`
  );
}

/**
 * Vote on a post.
 */
export async function voteOnPost(
  postShortId: string,
  voteType: "up" | "down"
): Promise<{ action: string }> {
  return apiClient.post<{ action: string }>(
    `/discussions/posts/${postShortId}/vote`,
    { vote_type: voteType }
  );
}

/**
 * Vote on a reply.
 */
export async function voteOnReply(
  replyId: string,
  voteType: "up" | "down"
): Promise<{ action: string }> {
  return apiClient.post<{ action: string }>(
    `/discussions/replies/${replyId}/vote`,
    { vote_type: voteType }
  );
}

/**
 * Get posts linked to a blueprint.
 */
export async function getPostsForBlueprint(
  identifier: string,
  limit: number = 5
): Promise<DiscussionPostSummary[]> {
  return apiClient.get<DiscussionPostSummary[]>(
    `/discussions/posts/by-blueprint/${encodeURIComponent(identifier)}?limit=${limit}`
  );
}

/**
 * Search discussions.
 */
export async function searchDiscussions(
  query: string,
  channelSlug?: string,
  limit: number = 20
): Promise<DiscussionSearchResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set("query", query);
  if (channelSlug) {
    searchParams.set("channel_slug", channelSlug);
  }
  searchParams.set("limit", limit.toString());

  return apiClient.post<DiscussionSearchResponse>(
    `/discussions/search?${searchParams.toString()}`
  );
}
