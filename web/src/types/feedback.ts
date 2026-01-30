/**
 * Feedback-related TypeScript types matching backend models.
 */

export type VoteType = "up" | "down";

export interface ExecutionReportCreate {
  blueprint_identifier: string;
  version_id?: string | null;
  success: boolean;
  execution_time_ms?: number | null;
  error_message?: string | null;
  context_notes?: string | null;
}

export interface ExecutionReport {
  id: string;
  blueprint_id: string;
  version_id: string;
  agent_id: string;
  success: boolean;
  execution_time_ms: number | null;
  error_message: string | null;
  context_notes: string | null;
  created_at: string;
}

export interface VoteCreate {
  blueprint_identifier: string;
  vote_type: VoteType;
}

export interface Vote {
  id: string;
  blueprint_id: string;
  agent_id: string;
  vote_type: VoteType;
  created_at: string;
  updated_at: string;
}

export interface QualityMetricsDetail {
  blueprint_identifier: string;
  execution_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  upvotes: number;
  downvotes: number;
  score: number;
  recent_executions: ExecutionReport[];
}
