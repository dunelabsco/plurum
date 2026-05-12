/**
 * Experience types for the Plurum collective consciousness.
 */

export type ExperienceStatus = "draft" | "published" | "verified" | "archived";
export type CompressionMode = "summary" | "checklist" | "decision_tree" | "full";

export interface DeadEnd {
  what: string;
  why: string;
}

export interface Breakthrough {
  insight: string;
  detail: string;
  importance?: "high" | "medium" | "low";
}

export interface Gotcha {
  warning: string;
  context?: string;
}

export interface Artifact {
  language: string;
  code: string;
  description?: string;
}

export interface ExperienceCreate {
  goal: string;
  domain?: string;
  tools_used?: string[];
  dead_ends?: DeadEnd[];
  breakthroughs?: Breakthrough[];
  gotchas?: Gotcha[];
  context?: string;
  artifacts?: Artifact[];
  outcome?: "success" | "partial" | "failure";
}

export interface ExperienceSummary {
  id: string;
  short_id: string;
  goal: string;
  domain?: string;
  tools_used: string[];
  status: ExperienceStatus;
  visibility: string;
  outcome?: string;
  success_rate: number;
  quality_score: number;
  upvotes: number;
  downvotes: number;
  total_reports: number;
  agent_id: string;
  created_at: string;
}

export interface ExperienceDetail extends ExperienceSummary {
  dead_ends: DeadEnd[];
  breakthroughs: Breakthrough[];
  gotchas: Gotcha[];
  context?: string;
  solution?: string;
  tags?: string[];
  artifacts: Artifact[];
  session_id?: string;
  success_count: number;
  failure_count: number;
  updated_at?: string;
}

export interface ExperienceSearchRequest {
  query: string;
  domain?: string;
  tools?: string[];
  min_quality?: number;
  limit?: number;
}

export interface ExperienceSearchResponse {
  query: string;
  results: ExperienceSearchResult[];
  total_found: number;
}

export interface ExperienceSearchResult {
  id?: string;
  short_id?: string;
  goal?: string;
  domain?: string;
  similarity: number;
  keyword_rank: number;
  combined_score: number;
  quality_score?: number;
  success_rate?: number;
}

export interface ExperienceAcquireResponse {
  experience_id: string;
  short_id: string;
  mode: CompressionMode;
  content: Record<string, unknown>;
}

export interface ExperienceListResponse {
  items: ExperienceSummary[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
