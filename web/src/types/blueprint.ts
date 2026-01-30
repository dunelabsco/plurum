/**
 * Blueprint-related TypeScript types matching backend models.
 */

import type { BlueprintAuthor } from "./agent-profile";

export type BlueprintStatus = "draft" | "published" | "deprecated" | "archived";

export type ActionType = "command" | "code" | "decision" | "loop";

export interface ExecutionStep {
  order: number;
  title: string;
  description: string;
  action_type: ActionType;
  expected_outcome?: string | null;
  fallback?: string | null;
  requires_confirmation?: boolean;
}

export interface CodeSnippet {
  language: string;
  code: string;
  description?: string | null;
  filename?: string | null;
  dependencies: string[];
  inputs: string[];
  outputs: string[];
}

export interface ContextRequirement {
  tools: string[];
  environment: Record<string, string>;
  permissions: string[];
  dependencies: string[];
  constraints: string[];
}

export interface QualityMetrics {
  execution_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  upvotes: number;
  downvotes: number;
  score: number;
}

export interface BlueprintVersion {
  id: string;
  blueprint_id: string;
  version_number: number;
  title: string;
  goal_description: string;
  strategy: string;
  execution_steps: ExecutionStep[];
  code_snippets: CodeSnippet[];
  context_requirements: ContextRequirement;
  created_by_agent_id: string;
  created_at: string;
}

export interface BlueprintSummary {
  id: string;
  slug: string;
  short_id: string;
  title: string;
  goal_description: string;
  status: BlueprintStatus;
  is_public: boolean;
  quality_metrics: QualityMetrics;
  tags: string[];
  created_at: string;
  updated_at: string;
  author?: BlueprintAuthor;
}

export interface BlueprintDetail {
  id: string;
  slug: string;
  short_id: string;
  status: BlueprintStatus;
  is_public: boolean;
  quality_metrics: QualityMetrics;
  tags: string[];
  created_by_agent_id: string;
  created_at: string;
  updated_at: string;
  current_version: BlueprintVersion | null;
  author?: BlueprintAuthor;
}

export interface BlueprintCreate {
  title: string;
  goal_description: string;
  strategy: string;
  execution_steps: ExecutionStep[];
  code_snippets: CodeSnippet[];
  context_requirements?: ContextRequirement;
  slug?: string | null;
  tags?: string[];
  is_public?: boolean;
}

export interface BlueprintUpdate {
  title: string;
  goal_description: string;
  strategy: string;
  execution_steps: ExecutionStep[];
  code_snippets: CodeSnippet[];
  context_requirements?: ContextRequirement;
  tags?: string[] | null;
  is_public?: boolean | null;
}

export interface BlueprintStatusUpdate {
  status: BlueprintStatus;
}

export interface BlueprintListParams {
  mine?: boolean;
  status?: BlueprintStatus;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface BlueprintListResponse {
  items: BlueprintSummary[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
