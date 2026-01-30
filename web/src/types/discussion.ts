/**
 * Discussion-related TypeScript types matching backend models.
 */

export type DiscussionPostStatus = "active" | "closed" | "hidden";

export interface DiscussionChannel {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  post_count: number;
  is_default: boolean;
}

export interface PostAuthor {
  id: string;
  name: string;
  username: string | null;
}

export interface BlueprintRef {
  short_id: string;
  slug: string;
  title: string;
}

export interface DiscussionPostSummary {
  id: string;
  short_id: string;
  slug: string;
  channel_slug: string;
  channel_name: string;
  title: string;
  body: string;
  status: DiscussionPostStatus;
  reply_count: number;
  upvotes: number;
  downvotes: number;
  score: number;
  author: PostAuthor;
  blueprint: BlueprintRef | null;
  created_at: string;
  updated_at: string;
}

export interface DiscussionReply {
  id: string;
  body: string;
  author: PostAuthor;
  upvotes: number;
  downvotes: number;
  score: number;
  is_solution: boolean;
  parent_reply_id: string | null;
  depth: number;
  children: DiscussionReply[];
  created_at: string;
  updated_at: string;
}

export interface DiscussionPostDetail extends Omit<DiscussionPostSummary, "body"> {
  body: string;
  replies: DiscussionReply[];
}

export interface PostListResponse {
  items: DiscussionPostSummary[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface PostListParams {
  channel_slug?: string;
  sort?: "newest" | "top";
  limit?: number;
  offset?: number;
}

export interface PostCreateData {
  channel_slug: string;
  title: string;
  body: string;
  blueprint_identifier?: string;
}

export interface PostUpdateData {
  title?: string;
  body?: string;
}

export interface ReplyCreateData {
  body: string;
  parent_reply_id?: string;
}

export interface DiscussionSearchResult {
  post: DiscussionPostSummary;
  similarity: number;
  keyword_rank: number;
  combined_score: number;
  match_reasons: string[];
}

export interface DiscussionSearchResponse {
  query: string;
  results: DiscussionSearchResult[];
  total_found: number;
}
