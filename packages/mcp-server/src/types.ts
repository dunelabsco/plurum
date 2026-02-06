/**
 * TypeScript type definitions for the Plurum collective consciousness.
 */

// ============================================================================
// Config
// ============================================================================

export interface PlurimMcpConfig {
  apiKey?: string;
  apiUrl: string;
}

// ============================================================================
// Enums / Literals
// ============================================================================

export type SessionStatus = "open" | "closed" | "abandoned";
export type Visibility = "public" | "team" | "private";
export type EntryType = "update" | "dead_end" | "breakthrough" | "gotcha" | "artifact" | "note";
export type ContributionType = "suggestion" | "warning" | "reference";
export type ExperienceStatus = "draft" | "published" | "verified" | "archived";
export type CompressionMode = "summary" | "checklist" | "decision_tree" | "full";
export type VoteType = "up" | "down";
export type Outcome = "success" | "partial" | "failure";

// ============================================================================
// Structured reasoning types
// ============================================================================

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

// ============================================================================
// Session types
// ============================================================================

export interface SessionCreateRequest {
  topic: string;
  domain?: string;
  tools_used?: string[];
  visibility?: Visibility;
}

export interface SessionEntryRequest {
  entry_type: EntryType;
  content: Record<string, unknown>;
}

export interface SessionCloseRequest {
  outcome?: Outcome;
}

export interface SessionSummary {
  id: string;
  short_id: string;
  agent_id: string;
  topic: string;
  domain?: string;
  tools_used: string[];
  status: SessionStatus;
  visibility: Visibility;
  outcome?: Outcome;
  entry_count: number;
  started_at: string;
  closed_at?: string;
}

export interface SessionEntry {
  id: string;
  session_id: string;
  entry_type: EntryType;
  content: Record<string, unknown>;
  ordinal: number;
  created_at: string;
}

export interface SessionDetail extends SessionSummary {
  entries: SessionEntry[];
}

export interface ActiveSessionMatch {
  session_id: string;
  short_id: string;
  agent_id: string;
  topic: string;
  domain?: string;
  tools_used: string[];
  similarity: number;
  started_at: string;
}

export interface SessionOpenResponse {
  session: SessionSummary;
  matching_experiences: unknown[];
  active_sessions: ActiveSessionMatch[];
}

// ============================================================================
// Experience types
// ============================================================================

export interface ExperienceCreateRequest {
  goal: string;
  domain?: string;
  tools_used?: string[];
  dead_ends?: DeadEnd[];
  breakthroughs?: Breakthrough[];
  gotchas?: Gotcha[];
  context?: string;
  artifacts?: Artifact[];
  visibility?: Visibility;
  outcome?: Outcome;
}

export interface ExperienceSearchRequest {
  query: string;
  domain?: string;
  tools?: string[];
  min_quality?: number;
  limit?: number;
}

export interface ExperienceAcquireRequest {
  mode: CompressionMode;
}

export interface ExperienceSummary {
  id: string;
  short_id: string;
  goal: string;
  domain?: string;
  tools_used: string[];
  status: ExperienceStatus;
  visibility: Visibility;
  outcome?: Outcome;
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
  artifacts: Artifact[];
  session_id?: string;
  success_count: number;
  failure_count: number;
  updated_at?: string;
}

export interface ExperienceSearchResponse {
  query: string;
  results: unknown[];
  total_found: number;
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

// ============================================================================
// Feedback types
// ============================================================================

export interface OutcomeReportRequest {
  success: boolean;
  execution_time_ms?: number;
  error_message?: string;
  context_notes?: string;
  env_fingerprint?: Record<string, string>;
}

export interface VoteRequest {
  vote_type: VoteType;
}

// ============================================================================
// Contribution types
// ============================================================================

export interface ContributionRequest {
  content: Record<string, unknown>;
  contribution_type: ContributionType;
}

// ============================================================================
// Pulse types
// ============================================================================

export interface PulseStatus {
  connected_agents: number;
  agent_ids: string[];
}
