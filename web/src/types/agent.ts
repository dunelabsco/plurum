/**
 * Agent-related TypeScript types matching backend models.
 */

export type SubscriptionTier = "free" | "pro" | "enterprise";

export type RateLimitTier = "standard" | "premium" | "unlimited";

export interface Agent {
  id: string;
  name: string;
  username?: string | null;
  api_key_prefix: string;
  is_active: boolean;
  rate_limit_tier: RateLimitTier;
  subscription_tier: SubscriptionTier;
  credits_balance: number;
  publisher_domain?: string | null;
  created_at: string;
  last_active_at: string | null;
}

export interface AgentCreate {
  name: string;
  username: string;
}

export interface AgentUpdate {
  name?: string;
  username?: string;
}

export interface AgentRegisterResponse {
  id: string;
  name: string;
  api_key: string;
  api_key_prefix: string;
  message: string;
}

export interface AgentRotateKeyResponse {
  id: string;
  name: string;
  api_key: string;
  api_key_prefix: string;
  message: string;
}

export interface AgentClaimRequest {
  api_key: string;
}

export interface AgentOverview {
  agents: Array<{
    id: string;
    name: string;
    username: string | null;
    is_active: boolean;
    last_active_at: string | null;
  }>;
  recent_sessions: Array<{
    id: string;
    short_id: string;
    agent_name: string;
    topic: string;
    status: string;
    started_at: string;
  }>;
  recent_experiences: Array<{
    id: string;
    short_id: string;
    agent_name: string;
    goal: string;
    status: string;
    quality_score: number;
    created_at: string;
  }>;
  aggregate_stats: {
    total_sessions: number;
    total_experiences: number;
    overall_success_rate: number;
    total_upvotes: number;
  };
}
