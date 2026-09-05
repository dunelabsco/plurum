import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const OWNER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GRANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "synthetic-private-error-that-must-not-be-returned";

// Execute the actual route handlers with only their external boundaries
// replaced. TypeScript and NextResponse are the project's installed versions.
function load(path, overrides = {}) {
  const code = ts.transpileModule(readFileSync(resolve(root, path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(code, {
    module: loaded, exports: loaded.exports, Request, Response, Headers, URL, URLSearchParams,
    TextEncoder, TextDecoder, Uint8Array,
    require(name) {
      if (name in overrides) return overrides[name];
      if (name === "@/lib/auth/oauth-http") return load("src/lib/auth/oauth-http.ts");
      if (name === "@/lib/auth/safe-redirect") return load("src/lib/auth/safe-redirect.ts");
      return require(name);
    },
  }, { filename: path });
  return loaded.exports;
}

class ServerAPIError extends Error {
  constructor(status) { super(SECRET); this.status = status; }
}

function harness(options = {}) {
  const calls = [];
  const api = {
    async get(path) {
      calls.push(["get", path]);
      if (options.status) throw new ServerAPIError(options.status);
      return [{ client_id: CLIENT, client_name: "Codex", grant_id: GRANT }];
    },
    async post(path, body) {
      calls.push(["post", path, JSON.parse(JSON.stringify(body))]);
      if (options.status) throw new ServerAPIError(options.status);
      if (path.endsWith("/disconnect")) return { state: options.pending ? "revocation_pending" : "disconnected" };
      if (path.endsWith("/binding-state")) return { state: options.changed ? "revoked" : "active", grant_id: GRANT };
      return { grant_id: GRANT };
    },
  };
  const supabase = { auth: {
    async getUser() {
      calls.push(["user"]);
      if (options.throwAuth) throw new Error(SECRET);
      return { data: { user: options.signedOut ? null : { id: OWNER } } };
    },
    oauth: {
      async getAuthorizationDetails(id) {
        calls.push(["details", id]);
        return { data: options.retained ? { redirect_url: "https://client.example/retained" } : {
          authorization_id: id, user: { id: OWNER }, client: { id: CLIENT },
        } };
      },
      async approveAuthorization(id) {
        calls.push(["approve", id]);
        return { data: { redirect_url: "https://client.example/approved" } };
      },
      async denyAuthorization(id) {
        calls.push(["deny", id]);
        return { data: { redirect_url: "https://client.example/denied" } };
      },
    },
  } };
  const overrides = {
    "@/lib/api/server": { serverApiClient: api, ServerAPIError },
    "@/lib/supabase/server": { createClient: async () => supabase },
  };
  return {
    calls,
    connections: load("src/app/api/oauth/connections/route.ts", overrides),
    decision: load("src/app/api/oauth/decision/route.ts", overrides),
  };
}

function request(fields, { origin = "https://plurum.test", headers = {} } = {}) {
  return new Request("https://plurum.test/api/oauth/connections", {
    method: "POST", headers: { ...(origin ? { Origin: origin } : {}), ...headers },
    body: fields instanceof URLSearchParams ? fields : new URLSearchParams(fields),
  });
}

const disconnectFields = { client_id: CLIENT, expected_grant_id: GRANT };
const consentFields = {
  authorization_id: "authorization_A", decision: "approve", selection_type: "existing",
  agent_id: AGENT, expected_grant_id: "",
};

function privateResponse(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}

test("list uses the human session and hides a disabled rollout", async () => {
  const active = harness();
  const response = await active.connections.GET();
  privateResponse(response);
  assert.equal((await response.json()).connections[0].client_id, CLIENT);
  assert.deepEqual(active.calls, [["user"], ["get", "/mcp/oauth/connections"]]);
  const disabled = await harness({ status: 404 }).connections.GET();
  assert.deepEqual(await disabled.json(), { enabled: false, connections: [] });
});

test("list and disconnect require sign-in", async () => {
  const h = harness({ signedOut: true });
  for (const response of [await h.connections.GET(), await h.connections.POST(request(disconnectFields))]) {
    assert.equal(response.status, 401);
    privateResponse(response);
  }
  assert.deepEqual(h.calls, [["user"], ["user"]]);
});

for (const pending of [false, true]) {
  test(`disconnect preserves exact client/version and pending=${pending}`, async () => {
    const h = harness({ pending });
    const response = await h.connections.POST(request(disconnectFields));
    assert.equal(response.status, pending ? 202 : 200);
    privateResponse(response);
    assert.deepEqual(h.calls[1], ["post", "/mcp/oauth/disconnect", disconnectFields]);
    assert.equal(response.headers.get("retry-after"), pending ? "30" : null);
  });
}

for (const origin of ["https://attacker.example", "", "https://plurum.test/invalid"]) {
  test(`cross-origin or missing origin is rejected: ${origin}`, async () => {
    const h = harness();
    const response = await h.connections.POST(request(disconnectFields, { origin }));
    assert.equal(response.status, 400);
    privateResponse(response);
    assert.equal(h.calls.length, 0);
  });
}

for (const fields of [
  { ...disconnectFields, client_id: "é".repeat(1025) },
  { ...disconnectFields, client_id: "bad\nid" },
  { ...disconnectFields, expected_grant_id: SECRET },
  { ...disconnectFields, owner_user_id: OWNER },
  { ...disconnectFields, extra: "x".repeat(17000) },
]) {
  test(`malformed disconnect is sanitized: ${Object.keys(fields).join(",")}/${Object.values(fields).map(v => v.length).join(",")}`, async () => {
    const h = harness();
    const response = await h.connections.POST(request(fields));
    assert.equal(response.status, 400);
    privateResponse(response);
    assert.equal(h.calls.length, 0);
    assert.ok(!(await response.text()).includes(SECRET));
  });
}

test("duplicate client identifiers are rejected before authentication", async () => {
  const fields = new URLSearchParams(disconnectFields);
  fields.append("client_id", "another-client");
  const h = harness();
  assert.equal((await h.connections.POST(request(fields))).status, 400);
  assert.equal(h.calls.length, 0);
});

for (const status of [409, 500]) {
  test(`backend failure ${status} remains sanitized and retryable`, async () => {
    const response = await harness({ status }).connections.POST(request(disconnectFields));
    assert.equal(response.status, status === 409 ? 409 : 503);
    privateResponse(response);
    assert.ok(!(await response.text()).includes(SECRET));
  });
}

test("consent binds the observed generation and checks it after approval", async () => {
  const h = harness();
  const response = await h.decision.POST(request(consentFields));
  assert.equal(response.headers.get("location"), "https://client.example/approved");
  privateResponse(response);
  assert.deepEqual(h.calls.slice(2), [
    ["post", "/mcp/oauth/bind", { client_id: CLIENT, agent_id: AGENT, expected_grant_id: null }],
    ["approve", "authorization_A"],
    ["post", "/mcp/oauth/binding-state", { client_id: CLIENT }],
  ]);
});

test("a disconnect racing approval suppresses the successful OAuth redirect", async () => {
  const response = await harness({ changed: true }).decision.POST(request(consentFields));
  assert.equal(response.headers.get("location"), "https://plurum.test/oauth/error");
  privateResponse(response);
});

for (const name of ["authorization_id", "decision", "agent_id", "expected_grant_id"]) {
  test(`consent rejects duplicate ${name}`, async () => {
    const h = harness();
    const fields = new URLSearchParams(consentFields);
    fields.append(name, fields.get(name));
    const response = await h.decision.POST(request(fields));
    assert.equal(response.status, 403);
    assert.equal(h.calls.length, 0);
    privateResponse(response);
  });
}

test("consent failures and denials never render provider diagnostics", async () => {
  const failure = await harness({ throwAuth: true }).decision.POST(request(consentFields));
  privateResponse(failure);
  assert.ok(!(await failure.text()).includes(SECRET));
  const h = harness();
  const denied = await h.decision.POST(request({ ...consentFields, decision: "deny" }));
  assert.equal(denied.headers.get("location"), "https://client.example/denied");
  assert.ok(!h.calls.some(([method]) => method === "post"));
});
