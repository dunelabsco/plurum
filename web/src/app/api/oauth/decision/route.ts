import { oauthConsentPath, parseAuthorizationId } from "@/lib/auth/safe-redirect";
import { serverApiClient } from "@/lib/api/server";
import { createClient } from "@/lib/supabase/server";
import { oauthJson, oauthRedirect, readExpectedGrantId, readOAuthForm } from "@/lib/auth/oauth-http";
import type { OAuthBindingState } from "@/lib/auth/oauth-types";

const AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;

export async function POST(request: Request) {
  try {
    return await decide(request);
  } catch {
    return oauthErrorRedirect(request);
  }
}

async function decide(request: Request) {
  const formData = await readOAuthForm(request, new Set([
    "authorization_id", "decision", "selection_type", "agent_id",
    "agent_name", "agent_username", "expected_grant_id",
  ]));
  if (!formData) {
    return oauthJson({ error: "Invalid request" }, 403);
  }
  const authorizationId = parseAuthorizationId(
    formString(formData, "authorization_id")
  );
  const decision = formString(formData, "decision");

  if (!authorizationId || (decision !== "approve" && decision !== "deny")) {
    return oauthErrorRedirect(request);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = oauthConsentPath(authorizationId);
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", next);
    return oauthRedirect(loginUrl);
  }

  const { data: authorization, error: detailsError } =
    await supabase.auth.oauth.getAuthorizationDetails(authorizationId);

  if (detailsError || !authorization) {
    return oauthErrorRedirect(request);
  }

  // Supabase returns only this URL when a retained grant already covers the
  // request. Its original Plurum binding remains authoritative and the MCP
  // verifier will still fail closed if that binding no longer exists.
  if ("redirect_url" in authorization) {
    return oauthRedirect(authorization.redirect_url);
  }

  if (
    authorization.authorization_id !== authorizationId ||
    authorization.user.id !== user.id
  ) {
    return oauthErrorRedirect(request);
  }

  if (decision === "deny") {
    const { data, error } = await supabase.auth.oauth.denyAuthorization(
      authorizationId,
      { skipBrowserRedirect: true }
    );
    if (error || !data?.redirect_url) {
      return oauthErrorRedirect(request);
    }
    return oauthRedirect(data.redirect_url);
  }

  const selection = readSelection(formData);
  const expectedGrantId = readExpectedGrantId(formData);
  if (!selection || expectedGrantId === undefined) {
    return oauthErrorRedirect(request);
  }

  // Make the exact agent selection durable before approving. The access-token
  // hook runs when the client exchanges the returned code and fails closed
  // without this binding. The create-and-bind endpoint is one DB transaction.
  let bound: { grant_id: string };
  try {
    if (selection.type === "existing") {
      bound = await serverApiClient.post("/mcp/oauth/bind", {
        client_id: authorization.client.id,
        agent_id: selection.agentId,
        expected_grant_id: expectedGrantId,
      });
    } else {
      bound = await serverApiClient.post("/mcp/oauth/create-and-bind", {
        client_id: authorization.client.id,
        name: selection.name,
        username: selection.username,
        expected_grant_id: expectedGrantId,
      });
    }
  } catch {
    const retryUrl = new URL(oauthConsentPath(authorizationId), request.url);
    retryUrl.searchParams.set("error", "agent_selection_failed");
    return oauthRedirect(retryUrl);
  }

  const { data: approval, error: approvalError } =
    await supabase.auth.oauth.approveAuthorization(authorizationId, {
      skipBrowserRedirect: true,
    });

  if (approvalError || !approval?.redirect_url) {
    return oauthErrorRedirect(request);
  }

  try {
    const current = await serverApiClient.post<OAuthBindingState>("/mcp/oauth/binding-state", {
      client_id: authorization.client.id,
    });
    if (current.state !== "active" || current.grant_id !== bound.grant_id) {
      return oauthErrorRedirect(request);
    }
  } catch {
    return oauthErrorRedirect(request);
  }
  return oauthRedirect(approval.redirect_url);
}

type Selection =
  | { type: "existing"; agentId: string }
  | { type: "new"; name: string; username: string };

function readSelection(formData: URLSearchParams): Selection | null {
  const selectionType = formString(formData, "selection_type");
  if (selectionType === "existing") {
    const agentId = formString(formData, "agent_id");
    return agentId && AGENT_ID_PATTERN.test(agentId)
      ? { type: "existing", agentId }
      : null;
  }

  if (selectionType !== "new") {
    return null;
  }

  const name = formString(formData, "agent_name")?.trim() ?? "";
  const username = formString(formData, "agent_username")?.trim() ?? "";
  if (
    name.length < 1 ||
    name.length > 255 ||
    username.length < 3 ||
    username.length > 50 ||
    !USERNAME_PATTERN.test(username)
  ) {
    return null;
  }
  return { type: "new", name, username };
}

function formString(formData: URLSearchParams, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function oauthErrorRedirect(request: Request) {
  return oauthRedirect(new URL("/oauth/error", request.url));
}
