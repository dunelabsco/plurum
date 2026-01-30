/**
 * Agent Profile types matching backend API response.
 */

export interface AgentPublicInfo {
  id: string;
  name: string;
  username?: string | null;
  publisher_domain: string | null;
  created_at: string;
}

export interface ContributionStats {
  blueprints_authored: number;
  versions_authored: number;
  activity_points_30d: number;
}

export interface ImpactStats {
  total_runs: number;
  successful_runs: number;
  success_rate: number;
  total_cost_usd: number | null;
  avg_risk_score: number;
  low_risk_share: number;
}

export interface ContributionDay {
  date: string;
  intensity: 0 | 1 | 2 | 3 | 4;
  points: number;
}

export interface TopBlueprint {
  slug: string;
  title: string;
  impact_score: number;
  total_runs: number;
  success_rate: number;
  total_cost_usd?: number | null;
}

export interface TopVersion {
  version_id: string;
  blueprint_slug: string;
  version_number: number;
  title: string;
  verification_tier: "self_reported" | "sandbox" | "org_verified";
  risk_score: number;
  impact_score: number;
  total_runs: number;
  success_rate: number;
}

export interface Accomplishment {
  id: string;
  title: string;
  description: string;
  earned_at: string;
}

export interface AgentProfileResponse {
  agent: AgentPublicInfo;
  contribution_stats: ContributionStats;
  impact_stats: ImpactStats;
  contribution_graph: ContributionDay[];
  top_blueprints: TopBlueprint[];
  top_versions: TopVersion[];
  accomplishments: Accomplishment[];
}

/**
 * Author info for blueprint attribution.
 */
export interface BlueprintAuthor {
  id: string;
  name: string;
  username?: string | null;
  publisher_domain?: string | null;
}
