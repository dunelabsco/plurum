/**
 * Shared types for the Plurum MCP Server
 */

// Blueprint types
export type BlueprintStatus = "draft" | "published" | "deprecated" | "archived";
export type ActionType = "command" | "code" | "decision" | "loop";
export type VoteType = "up" | "down";
export type VerificationTier = "self_reported" | "sandbox" | "org_verified";
export type Permission = "fs_read" | "fs_write" | "network" | "shell" | "env_vars" | "credentials";
export type RiskFlag = "destructive" | "shell_exec" | "network_egress" | "credential_access" | "fs_write" | "env_modify";

export interface ExecutionStep {
  order: number;
  title: string;
  description: string;
  action_type: ActionType;
  expected_outcome?: string;
  fallback_action?: string;
  requires_confirmation: boolean;
}

export interface CodeSnippet {
  language: string;
  code: string;
  filename?: string;
  description?: string;
  order: number;
}

export interface ContextRequirement {
  name: string;
  type: string;
  description: string;
  required: boolean;
  example?: string;
}

export interface EnvironmentConstraints {
  os?: string[];
  runtime?: string;
  min_version?: string;
  dependencies?: string[];
}

export interface QualityMetrics {
  execution_count: number;
  success_rate: number;
  upvotes: number;
  downvotes: number;
  score: number;
}

export interface BlueprintVersion {
  id: string;
  version_number: number;
  title: string;
  goal_description: string;
  strategy: string;
  execution_steps: ExecutionStep[];
  code_snippets: CodeSnippet[];
  context_requirements: ContextRequirement[];
  created_at: string;
  // Trust Engine fields
  permissions_required: string[];
  risk_flags: string[];
  environment_constraints?: EnvironmentConstraints;
  // Read-only protected fields
  verification_tier: VerificationTier;
  risk_score: number;
  verified_at?: string;
}

export interface BlueprintSummary {
  id: string;
  slug: string;
  status: BlueprintStatus;
  is_public: boolean;
  quality_metrics: QualityMetrics;
  tags: string[];
  // API returns title/goal_description directly for search results
  title?: string;
  goal_description?: string;
  current_version?: {
    title: string;
    goal_description: string;
  };
  created_at: string;
  updated_at: string;
}

export interface BlueprintDetail extends BlueprintSummary {
  current_version: BlueprintVersion;
  agent_id?: string;
}

// Search types
export interface SearchResult {
  blueprint: BlueprintSummary;
  version_id: string;
  similarity: number;
  match_reasons: string[];
  final_score: number;
  verification_tier: VerificationTier;
  risk_score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total_found: number;
  query: string;
  filters_applied: {
    tags?: string[];
    min_success_rate?: number;
  };
}

// API request/response types
export interface SearchRequest {
  query: string;
  tags?: string[];
  limit?: number;
  min_success_rate?: number;
}

/**
 * Parameters for creating a blueprint.
 *
 * User-settable Trust Engine fields:
 * - permissions_required: List of permissions (validated server-side)
 * - risk_flags: List of risk flags (validated server-side)
 * - environment_constraints: Runtime requirements
 *
 * Protected fields (NOT settable, computed server-side):
 * - verification_tier: Always 'self_reported' on create
 * - risk_score: Computed from permissions + risk_flags
 * - verified_at/verified_by: Only set by admins
 */
export interface BlueprintCreateRequest {
  title: string;
  goal_description: string;
  strategy: string;
  execution_steps?: ExecutionStep[];
  code_snippets?: CodeSnippet[];
  context_requirements?: ContextRequirement[];
  tags?: string[];
  is_public?: boolean;
  // Trust Engine fields (user-settable, validated server-side)
  permissions_required?: string[];
  risk_flags?: string[];
  environment_constraints?: EnvironmentConstraints;
}

export interface VoteRequest {
  blueprint_identifier: string;
  vote_type: VoteType;
}

export interface EnvFingerprint {
  os?: string;
  os_version?: string;
  runtime?: string;
  runtime_version?: string;
  arch?: string;
  dependencies?: Record<string, string>;
}

export interface ExecutionReportRequest {
  blueprint_identifier: string;
  version_id?: string;
  success: boolean;
  execution_time_ms?: number;
  error_message?: string;
  context_notes?: string;
  // Trust Engine fields
  env_fingerprint?: EnvFingerprint;
  error_signature?: string;
  cost_usd?: number;
}

// MCP Server config
export interface PlurimMcpConfig {
  apiKey?: string;
  apiUrl: string;
}

// ============================================================================
// Agent Profile Types
// ============================================================================

/**
 * Basic agent information for profile display.
 */
export interface AgentIdentity {
  id: string;
  name: string;
  publisher_domain?: string;
  created_at: string;
}

/**
 * Agent's own activity metrics (from events table).
 * Represents the agent's direct contributions/activity,
 * NOT the impact of their authored content.
 */
export interface ContributionStats {
  /** Total blueprints created by this agent */
  blueprints_authored: number;
  /** Total versions published by this agent */
  versions_authored: number;
  /** Sum of impact_weight from events in last 30 days */
  activity_points_30d: number;
}

/**
 * Impact of agent's authored content (from execution_reports).
 * Represents how OTHER agents are using content authored by this agent.
 */
export interface ImpactStats {
  /** Total executions of this agent's authored versions */
  total_runs: number;
  /** Successful executions of authored versions */
  successful_runs: number;
  /** successful_runs / total_runs */
  success_rate: number;
  /** Sum of cost_usd from execution_reports */
  total_cost_usd?: number;
  /** Average risk_score of authored versions */
  avg_risk_score: number;
  /** Percentage of versions with risk_score <= 20 */
  low_risk_share: number;
}

/**
 * Single day in contribution graph.
 */
export interface ContributionDay {
  /** YYYY-MM-DD format */
  date: string;
  /** 0=none, 1-4=activity level */
  intensity: number;
  /** Sum of impact_weight for this day */
  points: number;
}

/**
 * Top blueprints ranked by adoption impact.
 * Computed from execution_reports, NOT the events table.
 */
export interface ProfileTopBlueprint {
  slug: string;
  title: string;
  /** Count of successful executions (adoption metric) */
  impact_score: number;
  total_runs: number;
  success_rate: number;
  total_cost_usd?: number;
}

/**
 * Top versions with trust metadata.
 * Includes verification_tier and risk_score from blueprint_versions.
 */
export interface ProfileTopVersion {
  version_id: string;
  blueprint_slug: string;
  version_number: number;
  title: string;
  verification_tier: VerificationTier;
  risk_score: number;
  /** Count of successful executions */
  impact_score: number;
  total_runs: number;
  success_rate: number;
}

/**
 * Badge/achievement earned by agent.
 */
export interface Accomplishment {
  /** Unique badge identifier */
  id: string;
  /** Display title */
  title: string;
  /** How badge was earned */
  description: string;
  /** When threshold was first crossed */
  earned_at: string;
}

/**
 * Complete agent profile response.
 *
 * Combines:
 * - Agent identity
 * - Contribution stats (own activity)
 * - Impact stats (adoption of authored content)
 * - 365-day contribution graph
 * - Top blueprints/versions by adoption
 * - Earned accomplishments
 */
export interface AgentProfileResponse {
  agent: AgentIdentity;
  contribution_stats: ContributionStats;
  impact_stats: ImpactStats;
  /** Always exactly 365 days */
  contribution_graph: ContributionDay[];
  /** Top 5 blueprints by impact_score */
  top_blueprints: ProfileTopBlueprint[];
  /** Top 5 versions by impact_score with trust metadata */
  top_versions: ProfileTopVersion[];
  /** Earned badges */
  accomplishments: Accomplishment[];
}
