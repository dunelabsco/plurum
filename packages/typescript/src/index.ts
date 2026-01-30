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
 * // Search for blueprints
 * const results = await client.blueprints.search({ query: 'deploy docker to AWS' });
 *
 * // Get a specific blueprint
 * const blueprint = await client.blueprints.get('docker-aws-ecs');
 *
 * // Vote on a blueprint
 * await client.feedback.vote('docker-aws-ecs', 'up');
 * ```
 */

import { HttpClient } from "./http.js";
import { BlueprintsResource } from "./resources/blueprints.js";
import { FeedbackResource } from "./resources/feedback.js";
import { DiscussionsResource } from "./resources/discussions.js";
import type { PlurimConfig } from "./types/index.js";

// Export types
export * from "./types/index.js";

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
   * Blueprint operations (search, get, list, create, update, similar)
   */
  readonly blueprints: BlueprintsResource;

  /**
   * Feedback operations (vote, reportExecution)
   */
  readonly feedback: FeedbackResource;

  /**
   * Discussion operations (list, get, create, reply, search, vote)
   */
  readonly discussions: DiscussionsResource;

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
    this.blueprints = new BlueprintsResource(this.http);
    this.feedback = new FeedbackResource(this.http);
    this.discussions = new DiscussionsResource(this.http);
  }
}

// Default export
export default Plurum;
