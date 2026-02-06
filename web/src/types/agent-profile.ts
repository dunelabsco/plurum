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
  experiences_shared: number;
  sessions_completed: number;
  activity_points_30d: number;
}

export interface ImpactStats {
  total_reports: number;
  successful_reports: number;
  success_rate: number;
  total_cost_usd: number | null;
  avg_quality_score: number;
}

export interface ContributionDay {
  date: string;
  intensity: 0 | 1 | 2 | 3 | 4;
  points: number;
}

export interface TopExperience {
  short_id: string;
  goal: string;
  quality_score: number;
  total_reports: number;
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
  top_experiences: TopExperience[];
  accomplishments: Accomplishment[];
}

/**
 * Author info for agent attribution.
 */
export interface AgentInfo {
  id: string;
  name: string;
  username?: string | null;
  publisher_domain?: string | null;
}
