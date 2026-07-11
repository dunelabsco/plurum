const FALLBACK_PATH = "/dashboard";
const SAFE_BASE = "https://plurum.invalid";
const ALLOWED_PATHS = new Set([
  "/dashboard",
  "/dashboard/agents",
  "/dashboard/settings",
]);

export function safeDashboardRedirectPath(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    return FALLBACK_PATH;
  }

  try {
    const target = new URL(value, SAFE_BASE);
    if (target.origin !== SAFE_BASE || !ALLOWED_PATHS.has(target.pathname)) {
      return FALLBACK_PATH;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return FALLBACK_PATH;
  }
}
