import { ServerAPIError, serverApiClient } from "@/lib/api/server";
import { createClient } from "@/lib/supabase/server";
import { oauthJson, readExpectedGrantId, readOAuthForm } from "@/lib/auth/oauth-http";
import type { OAuthConnection } from "@/lib/auth/oauth-types";

const FIELDS = new Set(["client_id", "expected_grant_id"]);

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return oauthJson({ error: "sign in to manage connections" }, 401);
    const connections = await serverApiClient.get<OAuthConnection[]>("/mcp/oauth/connections");
    return oauthJson({ enabled: true, connections });
  } catch (error) {
    if (error instanceof ServerAPIError && error.status === 404) {
      return oauthJson({ enabled: false, connections: [] });
    }
    return oauthJson({ error: "connections could not be loaded. try again." }, 503);
  }
}

export async function POST(request: Request) {
  const form = await readOAuthForm(request, FIELDS);
  const clientId = form?.get("client_id");
  const expectedGrantId = form ? readExpectedGrantId(form) : undefined;
  if (!form || !clientId || /[\u0000-\u001f\u007f]/.test(clientId) ||
      new TextEncoder().encode(clientId).length > 2048 || expectedGrantId === undefined) {
    return oauthJson({ error: "invalid connection request" }, 400);
  }
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return oauthJson({ error: "sign in to manage connections" }, 401);
    const result = await serverApiClient.post<{ state: "disconnected" | "revocation_pending" }>(
      "/mcp/oauth/disconnect", { client_id: clientId, expected_grant_id: expectedGrantId }
    );
    const pending = result.state === "revocation_pending";
    const response = oauthJson(result, pending ? 202 : 200);
    if (pending) response.headers.set("Retry-After", "30");
    return response;
  } catch (error) {
    if (error instanceof ServerAPIError && error.status === 409) {
      return oauthJson({ error: "this connection changed. refresh before disconnecting." }, 409);
    }
    return oauthJson({ error: "disconnect could not be confirmed. refresh and try again." }, 503);
  }
}
