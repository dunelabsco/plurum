import { describe, expect, it } from "vitest";

import { ExitCode } from "../src/exit-codes.js";
import type { DiagnosticRuntime } from "../src/runtime.js";
import type { StatusReportV1 } from "../src/commands/status-contracts.js";
import {
  renderStatusJson,
  renderStatusText,
  writeStatusReport,
} from "../src/commands/status-output.js";

const API_KEY = "plrm_live_STATUS_OUTPUT_SECRET_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const USERNAME_KEY = "plrm_live_abcdefghij";
const PERSONAL_PATH = "/Users/private-owner/PRIVATE_OUTPUT_PATH_CANARY";
const BODY_CANARY = "PRIVATE_OUTPUT_BODY_CANARY";

function healthyReport(): StatusReportV1 {
  return {
    schemaVersion: 1,
    overall: "healthy",
    requestedClient: "all",
    selectedClients: ["claude-code", "codex"],
    cli: { version: "0.0.0-development" },
    api: {
      origin: "https://api.plurum.ai",
      reachability: "reachable",
      health: "healthy",
    },
    credential: {
      state: "ready",
      sources: ["canonical"],
      permissions: "verified-user-only",
      fingerprint: "plurum-fp-v1:0123456789ab",
      candidateCount: 1,
    },
    agent: {
      verification: "verified",
      id: "00000000-0000-4000-8000-000000000001",
      displayName: "Status Agent",
      username: "status-agent",
      active: true,
    },
    clients: [
      {
        client: "claude-code",
        status: "healthy",
        reason: "configuration-healthy",
        hostVersion: "2.1.212",
        pluginVersion: "0.2.0",
        pluginEnabled: true,
        credentialProjection: "not-applicable",
        mcp: {
          state: "plugin",
          endpoint: "https://mcp.plurum.ai/mcp",
        },
      },
      {
        client: "codex",
        status: "healthy",
        reason: "configuration-healthy",
        hostVersion: "0.144.5",
        pluginVersion: "0.1.0",
        pluginEnabled: true,
        credentialProjection: "exact",
        mcp: {
          state: "plugin",
          endpoint: "https://mcp.plurum.ai/mcp",
        },
      },
    ],
  };
}

function keyFragments(value: string, length = 10): readonly string[] {
  const fragments: string[] = [];
  for (let index = 0; index + length <= value.length; index += 1) {
    fragments.push(value.slice(index, index + length));
  }
  return Object.freeze(fragments);
}

function expectNoCanaries(value: string): void {
  for (const key of [API_KEY, USERNAME_KEY]) {
    for (const fragment of keyFragments(key)) {
      expect(value).not.toContain(fragment);
    }
  }
  for (const canary of [PERSONAL_PATH, "PRIVATE_OUTPUT_PATH_CANARY", BODY_CANARY]) {
    expect(value).not.toContain(canary);
  }
}

function captureRuntime(): Readonly<{
  runtime: DiagnosticRuntime;
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return Object.freeze({
    stdout,
    stderr,
    runtime: Object.freeze({
      stdout: Object.freeze({ write: (text: string) => stdout.push(text) }),
      stderr: Object.freeze({ write: (text: string) => stderr.push(text) }),
    }),
  });
}

describe("status output", () => {
  it("renders one exact versioned JSON success envelope with all semantic fields", () => {
    const rendered = renderStatusJson(healthyReport());

    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.split("\n")).toHaveLength(2);
    expect(JSON.parse(rendered)).toEqual({
      schema_version: 1,
      ok: true,
      command: "status",
      result: {
        overall: "healthy",
        requested_client: "all",
        selected_clients: ["claude-code", "codex"],
        cli: { version: "0.0.0-development" },
        api: {
          origin: "https://api.plurum.ai",
          reachability: "reachable",
          health: "healthy",
        },
        credential: {
          state: "ready",
          sources: ["canonical"],
          permissions: "verified-user-only",
          fingerprint: "plurum-fp-v1:0123456789ab",
          candidate_count: 1,
        },
        agent: {
          verification: "verified",
          id: "00000000-0000-4000-8000-000000000001",
          display_name: "Status Agent",
          username: "status-agent",
          active: true,
        },
        clients: [
          {
            client: "claude-code",
            status: "healthy",
            reason: "configuration-healthy",
            host_version: "2.1.212",
            plugin_version: "0.2.0",
            plugin_enabled: true,
            credential_projection: "not-applicable",
            mcp: {
              state: "plugin",
              endpoint: "https://mcp.plurum.ai/mcp",
            },
          },
          {
            client: "codex",
            status: "healthy",
            reason: "configuration-healthy",
            host_version: "0.144.5",
            plugin_version: "0.1.0",
            plugin_enabled: true,
            credential_projection: "exact",
            mcp: {
              state: "plugin",
              endpoint: "https://mcp.plurum.ai/mcp",
            },
          },
        ],
      },
    });
    expectNoCanaries(rendered);
  });

  it("renders deterministic human-readable output and states that observation is non-mutating", () => {
    const rendered = renderStatusText(healthyReport());

    expect(rendered).toBe(
      [
        "Plurum status",
        "overall: healthy",
        "requested client: all",
        "selected clients: claude-code, codex",
        'cli version: "0.0.0-development"',
        'api origin: "https://api.plurum.ai"',
        "api reachability: reachable",
        "api health: healthy",
        "credential state: ready",
        "credential sources: canonical",
        "credential permissions: verified-user-only",
        'credential fingerprint: "plurum-fp-v1:0123456789ab"',
        "credential candidates: 1",
        "agent verification: verified",
        'agent id: "00000000-0000-4000-8000-000000000001"',
        'agent display name: "Status Agent"',
        'agent username: "status-agent"',
        "agent active: true",
        "clients:",
        "  claude-code: healthy",
        "    reason: configuration-healthy",
        '    host version: "2.1.212"',
        '    plugin version: "0.2.0"',
        "    plugin enabled: true",
        "    credential projection: not-applicable",
        "    MCP state: plugin",
        '    MCP endpoint: "https://mcp.plurum.ai/mcp"',
        "  codex: healthy",
        "    reason: configuration-healthy",
        '    host version: "0.144.5"',
        '    plugin version: "0.1.0"',
        "    plugin enabled: true",
        "    credential projection: exact",
        "    MCP state: plugin",
        '    MCP endpoint: "https://mcp.plurum.ai/mcp"',
        "No changes were made.",
        "",
      ].join("\n"),
    );
    expectNoCanaries(rendered);
  });

  it("returns exit 0 for healthy and exit 1 for attention-required in text and JSON modes", () => {
    for (const json of [false, true]) {
      const healthy = captureRuntime();
      expect(writeStatusReport(healthyReport(), json, healthy.runtime)).toBe(
        ExitCode.Success,
      );
      expect(healthy.stdout).toHaveLength(1);
      expect(healthy.stderr).toEqual([]);

      const attention = captureRuntime();
      const report: StatusReportV1 = {
        ...healthyReport(),
        overall: "attention-required",
      };
      expect(writeStatusReport(report, json, attention.runtime)).toBe(
        ExitCode.OperationalFailure,
      );
      expect(attention.stdout).toHaveLength(1);
      expect(attention.stderr).toEqual([]);
      expect(attention.stdout[0]).toContain("attention-required");
    }
  });

  it("renders null and empty semantic values explicitly rather than omitting them", () => {
    const report: StatusReportV1 = {
      schemaVersion: 1,
      overall: "attention-required",
      requestedClient: "codex",
      selectedClients: ["codex"],
      cli: { version: "0.0.0-development" },
      api: { origin: null, reachability: "unknown", health: "unknown" },
      credential: {
        state: "missing",
        sources: [],
        permissions: "not-applicable",
        fingerprint: null,
        candidateCount: 0,
      },
      agent: {
        verification: "not-configured",
        id: null,
        displayName: null,
        username: null,
        active: null,
      },
      clients: [{
        client: "codex",
        status: "absent",
        reason: "host-not-installed",
        hostVersion: null,
        pluginVersion: null,
        pluginEnabled: null,
        credentialProjection: "not-applicable",
        mcp: { state: "absent", endpoint: null },
      }],
    };

    const json = JSON.parse(renderStatusJson(report));
    expect(json.result.credential.sources).toEqual([]);
    expect(json.result.api.origin).toBeNull();
    expect(json.result.agent.active).toBeNull();
    expect(json.result.clients[0].mcp.endpoint).toBeNull();

    const text = renderStatusText(report);
    expect(text).toContain("credential sources: none");
    expect(text).toContain("api origin: not available");
    expect(text).toContain("agent active: not available");
    expect(text).toContain("MCP endpoint: not available");
  });

  it.each([
    ["agent path", (report: StatusReportV1) => ({
      ...report,
      agent: { ...report.agent, displayName: PERSONAL_PATH },
    })],
    ["agent key", (report: StatusReportV1) => ({
      ...report,
      agent: { ...report.agent, displayName: API_KEY },
    })],
    ["agent key username", (report: StatusReportV1) => ({
      ...report,
      agent: { ...report.agent, username: USERNAME_KEY },
    })],
    ["prefixed-key API origin", (report: StatusReportV1) => ({
      ...report,
      api: { ...report.api, origin: `https://x${USERNAME_KEY}` },
    })],
    ["API body path", (report: StatusReportV1) => ({
      ...report,
      api: { ...report.api, origin: `https://api.plurum.ai/${BODY_CANARY}` },
    })],
    ["credential-shaped API origin", (report: StatusReportV1) => ({
      ...report,
      api: {
        ...report.api,
        origin: "https://plrm_live_status_output_secret.invalid",
      },
    })],
    ["host path", (report: StatusReportV1) => ({
      ...report,
      clients: [
        { ...report.clients[0], hostVersion: PERSONAL_PATH },
        report.clients[1],
      ],
    })],
    ["noncanonical MCP endpoint", (report: StatusReportV1) => ({
      ...report,
      clients: [
        report.clients[0],
        {
          ...report.clients[1],
          mcp: {
            ...report.clients[1]?.mcp,
            endpoint: `https://mcp.plurum.ai/mcp?${BODY_CANARY}`,
          },
        },
      ],
    })],
    ["credential-shaped fingerprint", (report: StatusReportV1) => ({
      ...report,
      credential: { ...report.credential, fingerprint: API_KEY },
    })],
  ] as const)("rejects a secret-bearing %s through one fixed safe error", (_label, mutate) => {
    const unsafe = mutate(healthyReport()) as StatusReportV1;

    for (const render of [renderStatusJson, renderStatusText]) {
      let message = "";
      try {
        render(unsafe);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("The status report could not be rendered safely.");
      expectNoCanaries(message);
    }

    const capture = captureRuntime();
    expect(() => writeStatusReport(unsafe, false, capture.runtime)).toThrowError(
      "The status report could not be rendered safely.",
    );
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([]);
  });

  it("rejects inconsistent selected-client order instead of relabeling observations", () => {
    const original = healthyReport();
    const inconsistent = {
      ...original,
      selectedClients: ["codex", "claude-code"],
    } as StatusReportV1;

    expect(() => renderStatusJson(inconsistent)).toThrowError(
      "The status report could not be rendered safely.",
    );
    expect(() => renderStatusText(inconsistent)).toThrowError(
      "The status report could not be rendered safely.",
    );
  });
});
