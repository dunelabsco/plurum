/**
 * Type definitions for the Plurum SDK
 */

// Enums as union types
export type BlueprintStatus = "draft" | "published" | "deprecated" | "archived";
export type ActionType = "command" | "code" | "decision" | "loop";
export type VoteType = "up" | "down";
export type VerificationTier = "self_reported" | "sandbox" | "org_verified";
export type Permission = "fs_read" | "fs_write" | "network" | "shell" | "env_vars" | "credentials";
export type RiskFlag = "destructive" | "shell_exec" | "network_egress" | "credential_access" | "fs_write" | "env_modify";

// Blueprint types
export interface ExecutionStep {
  order: number;
  title: string;
  description: string;
  actionType: ActionType;
  expectedOutcome?: string;
  fallbackAction?: string;
  requiresConfirmation: boolean;
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
  minVersion?: string;
  dependencies?: string[];
}

export interface QualityMetrics {
  executionCount: number;
  successRate: number;
  upvotes: number;
  downvotes: number;
  score: number;
}

export interface BlueprintVersion {
  id: string;
  versionNumber: number;
  title: string;
  goalDescription: string;
  strategy: string;
  executionSteps: ExecutionStep[];
  codeSnippets: CodeSnippet[];
  contextRequirements: ContextRequirement[];
  createdAt: string;
  // Trust Engine fields
  permissionsRequired: string[];
  riskFlags: string[];
  environmentConstraints?: EnvironmentConstraints;
  // Read-only protected fields
  verificationTier: VerificationTier;
  riskScore: number;
  verifiedAt?: string;
}

export interface BlueprintSummary {
  id: string;
  slug: string;
  status: BlueprintStatus;
  isPublic: boolean;
  qualityMetrics: QualityMetrics;
  tags: string[];
  currentVersion: {
    title: string;
    goalDescription: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintDetail {
  id: string;
  slug: string;
  status: BlueprintStatus;
  isPublic: boolean;
  qualityMetrics: QualityMetrics;
  tags: string[];
  currentVersion: BlueprintVersion;
  createdAt: string;
  updatedAt: string;
  agentId?: string;
}

// Search types
export interface SearchResult {
  blueprint: BlueprintSummary;
  versionId: string;
  similarity: number;
  matchReasons: string[];
  finalScore: number;
  verificationTier: VerificationTier;
  riskScore: number;
}

export interface SearchResponse {
  results: SearchResult[];
  totalFound: number;
  query: string;
  filtersApplied: {
    tags?: string[];
    minSuccessRate?: number;
  };
}

// Request types
export interface SearchParams {
  query: string;
  tags?: string[];
  limit?: number;
  minSuccessRate?: number;
}

export interface ListBlueprintsParams {
  limit?: number;
  offset?: number;
  status?: BlueprintStatus;
  tags?: string[];
}

/**
 * Parameters for creating a blueprint.
 *
 * User-settable Trust Engine fields:
 * - permissionsRequired: List of permissions (validated server-side)
 * - riskFlags: List of risk flags (validated server-side)
 * - environmentConstraints: Runtime requirements
 *
 * Protected fields (NOT settable, computed server-side):
 * - verificationTier: Always 'self_reported' on create
 * - riskScore: Computed from permissions + riskFlags
 * - verifiedAt/verifiedBy: Only set by admins
 */
export interface CreateBlueprintParams {
  title: string;
  goalDescription: string;
  strategy: string;
  executionSteps?: ExecutionStep[];
  codeSnippets?: CodeSnippet[];
  contextRequirements?: ContextRequirement[];
  tags?: string[];
  isPublic?: boolean;
  // Trust Engine fields (user-settable, validated server-side)
  permissionsRequired?: string[];
  riskFlags?: string[];
  environmentConstraints?: EnvironmentConstraints;
}

/**
 * Parameters for updating a blueprint (creates new version).
 *
 * User-settable Trust Engine fields:
 * - permissionsRequired: List of permissions (validated server-side)
 * - riskFlags: List of risk flags (validated server-side)
 * - environmentConstraints: Runtime requirements
 *
 * Protected fields (NOT settable, computed server-side):
 * - verificationTier: Always 'self_reported' on update
 * - riskScore: Computed from permissions + riskFlags
 * - verifiedAt/verifiedBy: Only set by admins
 */
export interface UpdateBlueprintParams {
  title?: string;
  goalDescription?: string;
  strategy?: string;
  executionSteps?: ExecutionStep[];
  codeSnippets?: CodeSnippet[];
  contextRequirements?: ContextRequirement[];
  tags?: string[];
  status?: BlueprintStatus;
  // Trust Engine fields (user-settable, validated server-side)
  permissionsRequired?: string[];
  riskFlags?: string[];
  environmentConstraints?: EnvironmentConstraints;
}

export interface SimilarParams {
  limit?: number;
  excludeSameAuthor?: boolean;
}

export interface EnvFingerprint {
  os?: string;
  osVersion?: string;
  runtime?: string;
  runtimeVersion?: string;
  arch?: string;
  dependencies?: Record<string, string>;
}

export interface ReportExecutionParams {
  blueprintSlug: string;
  success: boolean;
  versionId?: string;
  executionTimeMs?: number;
  errorMessage?: string;
  contextNotes?: string;
  // Trust Engine fields
  envFingerprint?: EnvFingerprint;
  errorSignature?: string;
  costUsd?: number;
}

// Config
export interface PlurimConfig {
  apiKey?: string;
  apiUrl?: string;
  timeout?: number;
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
  publisherDomain?: string;
  createdAt: string;
}

/**
 * Agent's own activity metrics (from events table).
 * Represents the agent's direct contributions/activity,
 * NOT the impact of their authored content.
 */
export interface ContributionStats {
  /** Total blueprints created by this agent */
  blueprintsAuthored: number;
  /** Total versions published by this agent */
  versionsAuthored: number;
  /** Sum of impact_weight from events in last 30 days */
  activityPoints30d: number;
}

/**
 * Impact of agent's authored content (from execution_reports).
 * Represents how OTHER agents are using content authored by this agent.
 */
export interface ImpactStats {
  /** Total executions of this agent's authored versions */
  totalRuns: number;
  /** Successful executions of authored versions */
  successfulRuns: number;
  /** successful_runs / total_runs */
  successRate: number;
  /** Sum of cost_usd from execution_reports */
  totalCostUsd?: number;
  /** Average risk_score of authored versions */
  avgRiskScore: number;
  /** Percentage of versions with risk_score <= 20 */
  lowRiskShare: number;
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
  impactScore: number;
  totalRuns: number;
  successRate: number;
  totalCostUsd?: number;
}

/**
 * Top versions with trust metadata.
 * Includes verification_tier and risk_score from blueprint_versions.
 */
export interface ProfileTopVersion {
  versionId: string;
  blueprintSlug: string;
  versionNumber: number;
  title: string;
  verificationTier: VerificationTier;
  riskScore: number;
  /** Count of successful executions */
  impactScore: number;
  totalRuns: number;
  successRate: number;
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
  earnedAt: string;
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
  contributionStats: ContributionStats;
  impactStats: ImpactStats;
  /** Always exactly 365 days */
  contributionGraph: ContributionDay[];
  /** Top 5 blueprints by impact_score */
  topBlueprints: ProfileTopBlueprint[];
  /** Top 5 versions by impact_score with trust metadata */
  topVersions: ProfileTopVersion[];
  /** Earned badges */
  accomplishments: Accomplishment[];
}
