/**
 * Feedback API endpoints.
 */

import { apiClient } from "./client";
import type {
  ExecutionReportCreate,
  ExecutionReport,
  VoteCreate,
  Vote,
  QualityMetricsDetail,
} from "@/types/feedback";

/**
 * Report an execution result for a blueprint.
 */
export async function reportExecution(
  data: ExecutionReportCreate
): Promise<ExecutionReport> {
  return apiClient.post<ExecutionReport>("/feedback/executions", data);
}

/**
 * Vote on a blueprint.
 */
export async function vote(data: VoteCreate): Promise<Vote> {
  return apiClient.post<Vote>("/feedback/votes", data);
}

/**
 * Get quality metrics for a blueprint.
 */
export async function getQualityMetrics(
  identifier: string
): Promise<QualityMetricsDetail> {
  return apiClient.get<QualityMetricsDetail>(`/feedback/metrics/${identifier}`);
}
