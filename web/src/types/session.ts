/**
 * Session types for Plurum collective intelligence.
 */

export type SessionStatus = "open" | "closed" | "abandoned";
export type Visibility = "public" | "team" | "private";
export type EntryType = "update" | "dead_end" | "breakthrough" | "gotcha" | "artifact" | "note";
export type ContributionType = "suggestion" | "warning" | "reference";

export interface SessionCreate {
  topic: string;
  domain?: string;
  tools_used?: string[];
  visibility?: Visibility;
}

export interface SessionEntryCreate {
  entry_type: EntryType;
  content: Record<string, unknown>;
}

export interface SessionClose {
  outcome?: "success" | "partial" | "failure";
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
  outcome?: string;
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

export interface SessionListResponse {
  items: SessionSummary[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ContributionCreate {
  content: Record<string, unknown>;
  contribution_type: ContributionType;
}

export interface Contribution {
  id: string;
  session_id: string;
  contributor_agent_id: string;
  content: Record<string, unknown>;
  contribution_type: ContributionType;
  created_at: string;
}
