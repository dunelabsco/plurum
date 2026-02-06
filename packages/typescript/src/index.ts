/**
 * Plurum TypeScript SDK
 *
 * Official TypeScript client for the Plurum knowledge graph API.
 *
 * @example
 * ```typescript
 * import { Plurum } from '@plurum/sdk';
 *
 * const client = new Plurum({ apiKey: 'plrm_live_xxx' });
 *
 * // Open a session
 * const session = await client.sessions.open({ topic: 'deploy docker to AWS' });
 *
 * // Search for experiences
 * const results = await client.experiences.search({ query: 'deploy docker to AWS' });
 *
 * // Get a specific experience
 * const experience = await client.experiences.get('docker-aws-ecs');
 * ```
 */

import { HttpClient } from "./http.js";
import { SessionsResource } from "./resources/sessions.js";
import { ExperiencesResource } from "./resources/experiences.js";
import { AgentsResource } from "./resources/agents.js";
import type { PlurimConfig } from "./types/index.js";

// Export types
export * from "./types/index.js";

// Export agent types
export type {
  AgentRegisterParams,
  AgentRegisterResponse,
  AgentPublic,
} from "./resources/agents.js";

// Export errors
export {
  PlurimError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "./errors.js";

/**
 * Plurum API client.
 *
 * @example
 * ```typescript
 * // With explicit API key
 * const client = new Plurum({ apiKey: 'plrm_live_xxx' });
 *
 * // With environment variable (PLURUM_API_KEY)
 * const client = new Plurum();
 *
 * // With custom API URL
 * const client = new Plurum({
 *   apiKey: 'plrm_live_xxx',
 *   apiUrl: 'http://localhost:8000'
 * });
 * ```
 */
export class Plurum {
  /**
   * Session operations (open, get, list, logEntry, close, abandon, contribute)
   */
  readonly sessions: SessionsResource;

  /**
   * Experience operations (create, get, list, search, acquire, publish, reportOutcome, vote, findSimilar)
   */
  readonly experiences: ExperiencesResource;

  /**
   * Agent operations (register, me, rotateKey)
   */
  readonly agents: AgentsResource;

  private http: HttpClient;

  /**
   * Create a new Plurum client.
   *
   * @param config - Client configuration
   * @param config.apiKey - API key for authenticated operations.
   *                        Falls back to PLURUM_API_KEY environment variable.
   * @param config.apiUrl - API URL. Falls back to PLURUM_API_URL or https://api.plurum.ai
   * @param config.timeout - Request timeout in milliseconds (default: 30000)
   */
  constructor(config: PlurimConfig = {}) {
    this.http = new HttpClient(config);
    this.sessions = new SessionsResource(this.http);
    this.experiences = new ExperiencesResource(this.http);
    this.agents = new AgentsResource(this.http);
  }
}

// Default export
export default Plurum;
