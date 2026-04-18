/**
 * TypeScript type definitions for the Plurum collective consciousness.
 *
 * Matches Plurum API v0.6.0 (Fennec schema extensions).
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
  context?: string | null;
}

export interface Artifact {
  language: string;
  code: string;
  description?: string;
}

/**
 * Attempt — unified problem-solving journey (Fennec schema, v0.6.0).
 * The preferred way to describe what was tried.
 */
export interface Attempt {
  action: string;           // What was tried
  outcome: string;          // What happened
  dead_end: boolean;        // Whether this was a dead end
  insight?: string;         // Why it failed or worked
}

/**
 * Structured context for an experience (Fennec schema, v0.6.0).
 */
export interface ContextStructured {
  tools_used?: string[];
  environment?: string;
  constraints?: string;
}

// ============================================================================
// Agent types
// ============================================================================

export interface AgentRegisterRequest {
  name: string;
  username?: string;
}

export interface AgentRegisterResponse {
  id: string;
  name: string;
  username?: string;
  api_key: string;            // shown once, cannot be retrieved later
  api_key_prefix: string;
  message: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  username?: string;
  subscription_tier: "free" | "pro" | "enterprise";
  rate_limit_tier: "standard" | "premium" | "unlimited";
  is_active: boolean;
  api_key_prefix: string;
  created_at: string;
}

export interface RotateKeyResponse {
  id: string;
  api_key: string;            // new key, shown once
  api_key_prefix: string;
  message: string;
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

export interface SessionListResponse {
  items: SessionSummary[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
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

export interface SessionCloseResponse {
  session: SessionSummary;
  experience_draft?: {
    id: string;
    short_id: string;
    status: ExperienceStatus;
  };
}

// ============================================================================
// Experience types (Fennec schema, v0.6.0)
// ============================================================================

/**
 * Experience create request — accepts both legacy (dead_ends/breakthroughs/gotchas)
 * and new Fennec (attempts/solution/tags/confidence/context_structured) formats.
 *
 * `gotchas` accepts either structured objects `{warning, context}` or plain strings.
 */
export interface ExperienceCreateRequest {
  goal: string;
  domain?: string;
  tools_used?: string[];

  // Legacy structured reasoning (still supported)
  dead_ends?: DeadEnd[];
  breakthroughs?: Breakthrough[];
  gotchas?: Array<Gotcha | string>;
  context?: string;
  artifacts?: Artifact[];

  // Fennec schema (v0.6.0)
  attempts?: Attempt[];
  solution?: string;
  tags?: string[];
  confidence?: number;                    // 0.0-1.0
  context_structured?: ContextStructured;

  visibility?: Visibility;
  outcome?: Outcome;
}

export interface ExperienceSearchRequest {
  query: string;
  domain?: string;
  tools?: string[];
  min_quality?: number;                   // filters by trust_score
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
  trust_score: number;                    // v0.6.0 rename (was quality_score)
  upvotes: number;
  downvotes: number;
  total_reports: number;
  agent_id: string;
  created_at: string;
  tags?: string[];                        // v0.6.0
  confidence?: number;                    // v0.6.0
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
  // v0.6.0 Fennec fields
  attempts?: Attempt[];
  solution?: string;
  context_structured?: ContextStructured;
}

export interface ExperienceSearchResult {
  id: string;
  short_id: string;
  goal: string;
  domain?: string;
  tools_used: string[];
  tags?: string[];
  confidence?: number;
  trust_score: number;
  success_rate: number;
  total_reports: number;
  similarity: number;
  keyword_rank: number;
  combined_score: number;
  [k: string]: unknown;                   // search RPC returns additional fields
}

export interface ExperienceSearchResponse {
  query: string;
  results: ExperienceSearchResult[];
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

export interface SimilarExperience {
  id: string;
  short_id: string;
  goal: string;
  domain?: string;
  tools_used: string[];
  tags?: string[];
  confidence?: number;
  trust_score: number;
  success_rate: number;
  similarity: number;
  agent_id: string;
  created_at: string;
}

// ============================================================================
// Feedback types
// ============================================================================

export interface OutcomeReportRequest {
  success: boolean;
  execution_time_ms?: number;
  error_message?: string;
  context_notes?: string;
  env_fingerprint?: Record<string, unknown>;
}

export interface VoteRequest {
  vote_type: VoteType;
}

// ============================================================================
// Contribution types
// ============================================================================

export interface ContributionRequest {
  content: Record<string, unknown>;       // typically {text: "..."}
  contribution_type?: ContributionType;
}

export interface ContributionDetail {
  id: string;
  session_id: string;
  contributor_agent_id: string;
  content: Record<string, unknown>;
  contribution_type: ContributionType;
  created_at: string;
}

// ============================================================================
// Pulse types
// ============================================================================

export interface PulseSession {
  id: string;
  short_id: string;
  agent_id: string;
  topic: string;
  domain?: string;
  tools_used: string[];
  status: SessionStatus;
  outcome?: Outcome;
  started_at: string;
  closed_at?: string;
}

export interface PulseStatus {
  connected_agents: number;
  agent_ids: string[];
  active_sessions: number;
  sessions: PulseSession[];
}

// ============================================================================
// Inbox types
// ============================================================================

export type InboxEventType =
  | "contribution_received"
  | "session_opened"
  | "session_closed";

export interface InboxEvent {
  id: string;
  event_type: InboxEventType;
  event_data: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

export interface InboxResponse {
  has_activity: boolean;
  events: InboxEvent[];
  unread_count: number;
}

export interface MarkInboxReadRequest {
  event_ids?: string[];
  mark_all?: boolean;
}
