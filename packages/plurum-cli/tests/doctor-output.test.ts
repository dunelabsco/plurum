import { describe, expect, it, vi } from "vitest";

import type {
  DoctorFinding,
  DoctorReportV1,
} from "../src/commands/doctor-contracts.js";
import {
  createDoctorJsonEnvelope,
  renderDoctorJson,
  renderDoctorText,
  writeDoctorReport,
} from "../src/commands/doctor-output.js";
import type { StatusReportV1 } from "../src/commands/status-contracts.js";
import { ExitCode } from "../src/exit-codes.js";
import type { DiagnosticRuntime } from "../src/runtime.js";

const KEY = "plrm_live_DOCTOR_OUTPUT_SECRET_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PATH = "/Users/private-owner/DOCTOR_PRIVATE_PATH_CANARY";
const BODY = "DOCTOR_PRIVATE_BODY_CANARY";
const OUTPUT_ERROR = "The doctor report could not be rendered safely.";

function finding(
  check: DoctorFinding["check"],
  outcome: DoctorFinding["outcome"],
  reason: DoctorFinding["reason"],
  client: DoctorFinding["client"] = null,
  guidance: DoctorFinding["guidance"] = [],
): DoctorFinding {
  return { check, outcome, reason, client, guidance };
}

function healthyStatus(): StatusReportV1 {
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
      displayName: "Doctor Agent",
      username: "doctor-agent",
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
        mcp: { state: "plugin", endpoint: "https://mcp.plurum.ai/mcp" },
      },
      {
        client: "codex",
        status: "healthy",
        reason: "configuration-healthy",
        hostVersion: "0.144.5",
        pluginVersion: "0.1.0",
        pluginEnabled: true,
        credentialProjection: "exact",
        mcp: { state: "plugin", endpoint: "https://mcp.plurum.ai/mcp" },
      },
    ],
  };
}

function healthyFindings(): readonly DoctorFinding[] {
  return [
    finding("runtime-platform", "pass", "runtime-platform-supported"),
    finding("status", "pass", "status-healthy"),
    finding("api", "pass", "api-healthy"),
    finding("credential", "pass", "credential-ready"),
    finding("host", "pass", "host-supported", "claude-code"),
    finding(
      "plugin-configuration",
      "pass",
      "plugin-configuration-healthy",
      "claude-code",
    ),
    finding(
      "local-registration",
      "pass",
      "local-plugin-registration-healthy",
      "claude-code",
    ),
    finding("host", "pass", "host-supported", "codex"),
    finding(
      "plugin-configuration",
      "pass",
      "plugin-configuration-healthy",
      "codex",
    ),
    finding(
      "local-registration",
      "pass",
      "local-plugin-registration-healthy",
      "codex",
    ),
    finding(
      "credential-projection",
      "pass",
      "credential-projection-exact",
      "codex",
    ),
    finding(
      "mcp-authentication-boundary",
      "pass",
      "mcp-authentication-boundary-healthy",
    ),
    finding(
      "mcp-protocol",
      "not-checked",
      "mcp-protocol-not-verified",
    ),
  ];
}

function healthyReport(): DoctorReportV1 {
  return {
    schemaVersion: 1,
    overall: "healthy",
    requestedClient: "all",
    selectedClients: ["claude-code", "codex"],
    runtimePlatform: {
      status: "supported",
      runtime: "node",
      version: "22.12.0",
      target: "darwin-arm64",
    },
    status: healthyStatus(),
    mcp: { reachability: "reachable", health: "healthy" },
    findings: healthyFindings(),
  };
}

function unsupportedReport(): DoctorReportV1 {
  return {
    schemaVersion: 1,
    overall: "attention-required",
    requestedClient: "all",
    selectedClients: ["claude-code", "codex"],
    runtimePlatform: {
      status: "unsupported",
      reason: "node-version",
      runtime: "node",
      version: "20.19.0",
      target: "darwin-arm64",
    },
    status: null,
    mcp: null,
    findings: [
      finding(
        "runtime-platform",
        "attention",
        "runtime-version-unsupported",
        null,
        ["update-runtime"],
      ),
      finding("status", "not-checked", "status-not-checked"),
      finding(
        "mcp-authentication-boundary",
        "not-checked",
        "mcp-authentication-boundary-not-checked",
      ),
      finding(
        "mcp-protocol",
        "not-checked",
        "mcp-protocol-not-verified",
      ),
    ],
  };
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

function expectNoCanaries(value: string): void {
  for (const canary of [KEY, "DOCTOR_OUTPUT_SECRET", PATH, BODY]) {
    expect(value).not.toContain(canary);
  }
}

describe("doctor output", () => {
  it("renders one versioned JSON envelope from only validated public fields", () => {
    const rendered = renderDoctorJson(healthyReport());
    const envelope = JSON.parse(rendered);

    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.split("\n")).toHaveLength(2);
    expect(envelope).toMatchObject({
      schema_version: 1,
      ok: true,
      command: "doctor",
      result: {
        overall: "healthy",
        requested_client: "all",
        selected_clients: ["claude-code", "codex"],
        runtime_platform: {
          status: "supported",
          runtime: "node",
          version: "22.12.0",
          target: "darwin-arm64",
        },
        status: {
          overall: "healthy",
          api: { reachability: "reachable", health: "healthy" },
          credential: { state: "ready", sources: ["canonical"] },
          clients: [
            { client: "claude-code", status: "healthy" },
            { client: "codex", status: "healthy" },
          ],
        },
        mcp: { reachability: "reachable", health: "healthy" },
      },
    });
    expect(envelope.result.findings).toEqual(healthyFindings());
    expect(envelope.result.status).not.toHaveProperty("command");
    expectNoCanaries(rendered);
  });

  it("renders deterministic text with explicit protocol and non-mutation limits", () => {
    const rendered = renderDoctorText(healthyReport());

    expect(rendered).toContain("overall: healthy");
    expect(rendered).toContain(
      "mcp-protocol: not-checked (mcp-protocol-not-verified)",
    );
    expect(rendered).toContain("repair guidance:\n  none");
    expect(rendered.endsWith([
      "MCP protocol initialization and tool inventory were not checked.",
      "Repair guidance was not executed.",
      "No local configuration changes were made.",
      "",
    ].join("\n"))).toBe(true);
    expectNoCanaries(rendered);
  });

  it("returns exit 0 for healthy and exit 1 for attention in both modes", () => {
    for (const json of [false, true]) {
      const healthy = captureRuntime();
      expect(writeDoctorReport(healthyReport(), json, healthy.runtime)).toBe(
        ExitCode.Success,
      );
      expect(healthy.stdout).toHaveLength(1);
      expect(healthy.stderr).toEqual([]);

      const attention = captureRuntime();
      expect(
        writeDoctorReport(unsupportedReport(), json, attention.runtime),
      ).toBe(ExitCode.OperationalFailure);
      expect(attention.stdout).toHaveLength(1);
      expect(attention.stderr).toEqual([]);
      expect(attention.stdout[0]).toContain("attention-required");
      expect(attention.stdout[0]).toContain("update-runtime");
    }
  });

  it.each([
    [
      "supported Node outside the released range",
      (report: DoctorReportV1) => ({
        ...report,
        runtimePlatform: { ...report.runtimePlatform, version: "23.0.0" },
      }),
    ],
    [
      "node-version reason for a supported Node",
      (_report: DoctorReportV1) => ({
        ...unsupportedReport(),
        runtimePlatform: {
          status: "unsupported",
          reason: "node-version",
          runtime: "node",
          version: "24.0.0",
          target: "darwin-arm64",
        },
      }),
    ],
    [
      "platform-target reason for an unsupported Node",
      (_report: DoctorReportV1) => ({
        ...unsupportedReport(),
        runtimePlatform: {
          status: "unsupported",
          reason: "platform-target",
          runtime: "node",
          version: "20.0.0",
          target: null,
        },
        findings: [
          finding(
            "runtime-platform",
            "attention",
            "platform-target-unsupported",
            null,
            ["use-supported-platform"],
          ),
          ...unsupportedReport().findings.slice(1),
        ],
      }),
    ],
    [
      "an API finding contradicted by status",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          api: {
            ...report.status!.api,
            health: "unhealthy" as const,
          },
        },
      }),
    ],
    [
      "a credential finding contradicted by status",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          credential: {
            ...report.status!.credential,
            state: "missing" as const,
          },
        },
      }),
    ],
    [
      "healthy status contradicted by unverified agent evidence",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          agent: {
            ...report.status!.agent,
            verification: "unavailable" as const,
            id: null,
            displayName: null,
            username: null,
            active: null,
          },
        },
      }),
    ],
    [
      "healthy status contradicted by a missing API origin",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          api: { ...report.status!.api, origin: null },
        },
      }),
    ],
    [
      "healthy status contradicted by an inexact Codex projection",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "codex"
              ? {
                  ...client,
                  credentialProjection: "not-applicable" as const,
                }
              : client,
          ),
        },
        findings: report.findings.map((entry) =>
          entry.check === "credential-projection"
            ? finding(
                "credential-projection",
                "not-checked",
                "credential-projection-not-applicable",
                "codex",
              )
            : entry,
        ),
      }),
    ],
    [
      "healthy status contradicted by an unsupported host version",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "claude-code"
              ? { ...client, hostVersion: "2.0.0" }
              : client,
          ),
        },
      }),
    ],
    [
      "healthy status contradicted by an incompatible plugin version",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "claude-code"
              ? { ...client, pluginVersion: "0.3.0" }
              : client,
          ),
        },
      }),
    ],
    [
      "healthy status contradicted by a missing plugin MCP endpoint",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "codex"
              ? { ...client, mcp: { ...client.mcp, endpoint: null } }
              : client,
          ),
        },
      }),
    ],
    [
      "healthy status contradicted by a Claude credential projection",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "claude-code"
              ? { ...client, credentialProjection: "exact" as const }
              : client,
          ),
        },
      }),
    ],
    [
      "a host finding contradicted by status",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "claude-code"
              ? { ...client, hostVersion: null }
              : client,
          ),
        },
      }),
    ],
    [
      "a plugin finding contradicted by status",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "claude-code"
              ? { ...client, pluginVersion: "0.1.0" }
              : client,
          ),
        },
      }),
    ],
    [
      "a registration finding contradicted by status",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "claude-code"
              ? { ...client, mcp: { ...client.mcp, state: "direct" as const } }
              : client,
          ),
        },
      }),
    ],
    [
      "a projection finding contradicted by status",
      (report: DoctorReportV1) => ({
        ...report,
        status: {
          ...report.status!,
          clients: report.status!.clients.map((client) =>
            client.client === "codex"
              ? { ...client, credentialProjection: "absent" as const }
              : client,
          ),
        },
      }),
    ],
    [
      "an MCP finding contradicted by its boundary result",
      (report: DoctorReportV1) => ({
        ...report,
        mcp: { reachability: "reachable" as const, health: "unhealthy" as const },
      }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() => renderDoctorJson(mutate(healthyReport()) as DoctorReportV1))
      .toThrowError(OUTPUT_ERROR);
  });

  it("rejects arbitrary guidance without output", () => {
    const baseline = healthyReport();
    const report = {
      ...baseline,
      findings: baseline.findings.map((entry, index) =>
        index === 0
          ? { ...entry, guidance: [KEY] }
          : entry,
      ),
    } as DoctorReportV1;
    const capture = captureRuntime();

    expect(() => writeDoctorReport(report, true, capture.runtime))
      .toThrowError(OUTPUT_ERROR);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([]);
  });

  it("rejects extra fields and symbols without reflecting them", () => {
    const report = healthyReport() as DoctorReportV1 &
      Record<string | symbol, unknown>;
    report[Symbol("private")] = PATH;
    report.privateBody = BODY;
    const capture = captureRuntime();

    expect(() => writeDoctorReport(report, true, capture.runtime))
      .toThrowError(OUTPUT_ERROR);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([]);
  });

  it("does not invoke hostile nested accessors while rejecting the report", () => {
    const getter = vi.fn(() => KEY);
    const status = healthyStatus();
    Object.defineProperty(status.api, "origin", {
      enumerable: true,
      configurable: true,
      get: getter,
    });
    const report = { ...healthyReport(), status };

    expect(() => createDoctorJsonEnvelope(report)).toThrowError(OUTPUT_ERROR);
    expect(getter).not.toHaveBeenCalled();
  });
});
