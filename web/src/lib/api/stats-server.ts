/**
 * Server-side Stats API endpoints.
 * For use in Server Components only.
 */

import { serverApiClient } from "./server";
import type { PlatformStats } from "@/types/stats";

/**
 * Get platform-wide statistics (server-side).
 */
export async function getPlatformStatsServer(): Promise<PlatformStats> {
  return serverApiClient.get<PlatformStats>("/stats");
}
