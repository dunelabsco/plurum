const FALLBACK_PATH = "/dashboard";
const SAFE_BASE = "https://plurum.invalid";
const DASHBOARD_PATHS = new Set([
  "/dashboard",
  "/dashboard/agents",
  "/dashboard/settings",
]);
const OAUTH_CONSENT_PATH = "/oauth/consent";
const UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F]/;
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function parseAuthorizationId(value: string | null): string | null {
  return value && AUTHORIZATION_ID_PATTERN.test(value) ? value : null;
}

export function oauthConsentPath(authorizationId: string): string {
  const safeAuthorizationId = parseAuthorizationId(authorizationId);
  if (!safeAuthorizationId) {
    return FALLBACK_PATH;
  }
  return `${OAUTH_CONSENT_PATH}?authorization_id=${encodeURIComponent(safeAuthorizationId)}`;
}

export function safeAuthRedirectPath(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    UNSAFE_CHARACTERS.test(value)
  ) {
    return FALLBACK_PATH;
  }

  try {
    const target = new URL(value, SAFE_BASE);
    if (target.origin !== SAFE_BASE) {
      return FALLBACK_PATH;
    }

    if (DASHBOARD_PATHS.has(target.pathname)) {
      return `${target.pathname}${target.search}${target.hash}`;
    }

    if (target.pathname !== OAUTH_CONSENT_PATH || target.hash) {
      return FALLBACK_PATH;
    }

    const parameterNames = [...target.searchParams.keys()];
    const authorizationIds = target.searchParams.getAll("authorization_id");
    if (
      parameterNames.length !== 1 ||
      parameterNames[0] !== "authorization_id" ||
      authorizationIds.length !== 1
    ) {
      return FALLBACK_PATH;
    }

    const authorizationId = parseAuthorizationId(authorizationIds[0]);
    if (!authorizationId) {
      return FALLBACK_PATH;
    }

    return oauthConsentPath(authorizationId);
  } catch {
    return FALLBACK_PATH;
  }
}
