/**
 * Server-side Discussion API endpoints.
 * For use in Server Components only.
 */

import { serverApiClient } from "./server";
import type {
  DiscussionChannel,
  DiscussionPostDetail,
  DiscussionPostSummary,
  PostListResponse,
  PostListParams,
} from "@/types/discussion";

/**
 * List all discussion channels (server-side).
 */
export async function listChannelsServer(): Promise<DiscussionChannel[]> {
  return serverApiClient.get<DiscussionChannel[]>("/discussions/channels");
}

/**
 * List discussion posts (server-side).
 */
export async function listDiscussionPostsServer(
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

  return serverApiClient.get<PostListResponse>(endpoint);
}

/**
 * List recent posts across all channels (server-side).
 */
export async function listRecentPostsServer(
  limit: number = 20
): Promise<DiscussionPostSummary[]> {
  return serverApiClient.get<DiscussionPostSummary[]>(
    `/discussions/posts/recent?limit=${limit}`
  );
}

/**
 * Get a discussion post by short_id (server-side).
 */
export async function getDiscussionPostServer(
  shortId: string
): Promise<DiscussionPostDetail> {
  return serverApiClient.get<DiscussionPostDetail>(
    `/discussions/posts/${shortId}`
  );
}
