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
