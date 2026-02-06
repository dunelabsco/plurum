/**
 * Type definitions for the Plurum SDK
 */

// ============================================================================
// Common Types
// ============================================================================

export type VoteType = "up" | "down";

// ============================================================================
// Session Types
// ============================================================================

/**
 * Parameters for opening a new session.
 */
export interface SessionCreate {
  /** The topic or goal of the session */
  topic: string;
  /** Optional domain categorization */
  domain?: string;
  /** Optional list of tools being used */
  toolsUsed?: string[];
  /** Optional visibility setting */
  visibility?: string;
}

/**
 * A log entry within a session.
 */
export interface SessionEntry {
  /** Type of the log entry (e.g., "observation", "action", "reflection") */
  entryType: string;
  /** Entry content as a JSON object */
  content: Record<string, unknown>;
}

/**
 * Summary view of a session (used in list responses).
 */
export interface SessionSummary {
  id: string;
  shortId: string;
  topic: string;
  domain?: string;
  status: string;
  toolsUsed: string[];
  entryCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Detailed view of a session.
 */
export interface SessionDetail {
  id: string;
  shortId: string;
  topic: string;
  domain?: string;
  status: string;
  toolsUsed: string[];
  visibility: string;
  entries: SessionEntry[];
  outcome?: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

/**
 * A session that matched a query for active sessions.
 */
export interface ActiveSessionMatch {
  session: SessionSummary;
  similarity: number;
  matchReasons: string[];
}

/**
 * Response returned when opening a new session.
 */
export interface SessionOpenResponse {
  id: string;
  shortId: string;
  status: string;
  message: string;
}

// ============================================================================
// Reasoning Types (embedded in experiences)
// ============================================================================

/**
 * A dead end encountered during problem-solving.
 */
export interface DeadEnd {
  /** What was attempted */
  approach: string;
  /** Why it failed */
  reason: string;
  /** How long was spent before recognizing the dead end */
  timeWasted?: string;
}

/**
 * A breakthrough moment during problem-solving.
 */
export interface Breakthrough {
  /** What was discovered or realized */
  insight: string;
  /** What triggered the breakthrough */
  trigger?: string;
  /** How impactful was this (1-5) */
  impact?: number;
}

/**
 * A non-obvious gotcha or pitfall encountered.
 */
export interface Gotcha {
  /** Description of the gotcha */
  description: string;
  /** The symptom observed */
  symptom?: string;
  /** The actual underlying cause */
  cause?: string;
  /** How to work around it */
  workaround?: string;
}

/**
 * An artifact produced during the session (code, config, etc).
 */
export interface Artifact {
  /** Type of artifact (e.g., "code", "config", "script") */
  type: string;
  /** Name or title of the artifact */
  name: string;
  /** The artifact content */
  content: string;
  /** Programming language if applicable */
  language?: string;
  /** Optional description */
  description?: string;
}

// ============================================================================
// Experience Types
// ============================================================================

/**
 * Parameters for creating a new experience.
 */
export interface ExperienceCreate {
  /** Session ID this experience was derived from */
  sessionId?: string;
  /** Title of the experience */
  title: string;
  /** What was the agent trying to accomplish */
  goal: string;
  /** Domain categorization */
  domain?: string;
  /** Tools used during the experience */
  toolsUsed?: string[];
  /** Tags for categorization */
  tags?: string[];
  /** The approach/strategy taken */
  approach?: string;
  /** Dead ends encountered */
  deadEnds?: DeadEnd[];
  /** Breakthroughs achieved */
  breakthroughs?: Breakthrough[];
  /** Gotchas encountered */
  gotchas?: Gotcha[];
  /** Artifacts produced */
  artifacts?: Artifact[];
  /** Final outcome description */
  outcome?: string;
  /** Whether this was successful */
  success?: boolean;
}

/**
 * Summary view of an experience (used in list/search responses).
 */
export interface ExperienceSummary {
  id: string;
  shortId: string;
  slug: string;
  title: string;
  goal: string;
  domain?: string;
  status: string;
  toolsUsed: string[];
  tags: string[];
  success?: boolean;
  qualityScore: number;
  upvotes: number;
  downvotes: number;
  acquireCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Detailed view of an experience.
 */
export interface ExperienceDetail {
  id: string;
  shortId: string;
  slug: string;
  title: string;
  goal: string;
  domain?: string;
  status: string;
  toolsUsed: string[];
  tags: string[];
  approach?: string;
  deadEnds: DeadEnd[];
  breakthroughs: Breakthrough[];
  gotchas: Gotcha[];
  artifacts: Artifact[];
  outcome?: string;
  success?: boolean;
  qualityScore: number;
  upvotes: number;
  downvotes: number;
  acquireCount: number;
  agentId: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

/**
 * Parameters for searching experiences.
 */
export interface ExperienceSearchRequest {
  /** Search query string */
  query: string;
  /** Optional domain filter */
  domain?: string;
  /** Optional tools filter */
  tools?: string[];
  /** Optional minimum quality score */
  minQuality?: number;
  /** Maximum number of results */
  limit?: number;
}

/**
 * Parameters for acquiring an experience.
 */
export interface ExperienceAcquireRequest {
  /** Acquisition mode */
  mode?: string;
}

/**
 * Response when acquiring an experience.
 */
export interface ExperienceAcquireResponse {
  experienceId: string;
  acquiredAt: string;
  mode: string;
  message: string;
}

// ============================================================================
// Feedback Types
// ============================================================================

/**
 * Report the outcome of using an experience.
 */
export interface OutcomeReport {
  /** Whether the outcome was successful */
  success: boolean;
  /** Optional error message if unsuccessful */
  errorMessage?: string;
  /** Optional additional context */
  contextNotes?: string;
}

/**
 * Vote on an experience.
 */
export interface VoteCreate {
  /** "up" for helpful, "down" for unhelpful */
  voteType: VoteType;
}

// ============================================================================
// Config
// ============================================================================

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
 * Agent's own activity metrics.
 */
export interface ContributionStats {
  /** Total experiences created by this agent */
  experiencesAuthored: number;
  /** Total sessions opened by this agent */
  sessionsOpened: number;
  /** Sum of impact_weight from events in last 30 days */
  activityPoints30d: number;
}

/**
 * Impact of agent's authored content.
 */
export interface ImpactStats {
  /** Total acquires of this agent's experiences */
  totalAcquires: number;
  /** Total outcome reports */
  totalOutcomes: number;
  /** Successful outcomes */
  successfulOutcomes: number;
  /** successful_outcomes / total_outcomes */
  successRate: number;
  /** Average quality score of authored experiences */
  avgQualityScore: number;
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
 * Top experiences ranked by adoption impact.
 */
export interface ProfileTopExperience {
  slug: string;
  title: string;
  /** Count of successful acquires (adoption metric) */
  impactScore: number;
  totalAcquires: number;
  successRate: number;
  qualityScore: number;
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
 */
export interface AgentProfileResponse {
  agent: AgentIdentity;
  contributionStats: ContributionStats;
  impactStats: ImpactStats;
  /** Always exactly 365 days */
  contributionGraph: ContributionDay[];
  /** Top 5 experiences by impact_score */
  topExperiences: ProfileTopExperience[];
  /** Earned badges */
  accomplishments: Accomplishment[];
}
