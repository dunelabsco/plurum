/**
 * Feedback resource for the Plurum SDK
 */

import type { HttpClient } from "../http.js";
import type { VoteType, ReportExecutionParams } from "../types/index.js";

// Helper to convert camelCase to snake_case for API
function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    if (value !== undefined) {
      result[snakeKey] = value;
    }
  }
  return result;
}

export class FeedbackResource {
  constructor(private http: HttpClient) {}

  /**
   * Vote on a blueprint.
   *
   * @param blueprintSlug - The slug of the blueprint to vote on
   * @param voteType - "up" for helpful, "down" for unhelpful
   */
  async vote(
    blueprintSlug: string,
    voteType: VoteType
  ): Promise<{ message: string }> {
    return this.http.post<{ message: string }>(
      "/api/v1/feedback/votes",
      {
        blueprint_slug: blueprintSlug,
        vote_type: voteType,
      },
      true
    );
  }

  /**
   * Report the result of executing a blueprint.
   *
   * @param params - Execution report parameters
   */
  async reportExecution(
    params: ReportExecutionParams
  ): Promise<{ message: string }> {
    return this.http.post<{ message: string }>(
      "/api/v1/feedback/executions",
      toSnakeCase(params as unknown as Record<string, unknown>),
      true
    );
  }
}
