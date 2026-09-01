import { NextResponse } from "next/server";

import { oauthConsentPath, parseAuthorizationId } from "@/lib/auth/safe-redirect";
import { serverApiClient } from "@/lib/api/server";
import { createClient } from "@/lib/supabase/server";

const AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;

export async function POST(request: Request) {
  if (!hasSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 403 });
  }

  const formData = await request.formData();
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
    return NextResponse.redirect(loginUrl, { status: 303 });
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
    return NextResponse.redirect(authorization.redirect_url, { status: 303 });
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
    return NextResponse.redirect(data.redirect_url, { status: 303 });
  }

  const selection = readSelection(formData);
  if (!selection) {
    return oauthErrorRedirect(request);
  }

  // Make the exact agent selection durable before approving. The access-token
  // hook runs when the client exchanges the returned code and fails closed
  // without this binding. The create-and-bind endpoint is one DB transaction.
  try {
    if (selection.type === "existing") {
      await serverApiClient.post("/mcp/oauth/bind", {
        client_id: authorization.client.id,
        agent_id: selection.agentId,
      });
    } else {
      await serverApiClient.post("/mcp/oauth/create-and-bind", {
        client_id: authorization.client.id,
        name: selection.name,
        username: selection.username,
      });
    }
  } catch {
    const retryUrl = new URL(oauthConsentPath(authorizationId), request.url);
    retryUrl.searchParams.set("error", "agent_selection_failed");
    return NextResponse.redirect(retryUrl, { status: 303 });
  }

  const { data: approval, error: approvalError } =
    await supabase.auth.oauth.approveAuthorization(authorizationId, {
      skipBrowserRedirect: true,
    });

  if (approvalError || !approval?.redirect_url) {
    return oauthErrorRedirect(request);
  }

  return NextResponse.redirect(approval.redirect_url, { status: 303 });
}

type Selection =
  | { type: "existing"; agentId: string }
  | { type: "new"; name: string; username: string };

function readSelection(formData: FormData): Selection | null {
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

function formString(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function oauthErrorRedirect(request: Request) {
  return NextResponse.redirect(new URL("/oauth/error", request.url), {
    status: 303,
  });
}
