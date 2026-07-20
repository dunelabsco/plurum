import { describe, expect, it } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import type { HostExecutableAttestation } from "../src/hosts/contracts.js";
import { HostError } from "../src/hosts/errors.js";
import {
  validateHostExecutableAttestation,
} from "../src/hosts/inspection.js";
import {
  StreamingHostOutputRedactor,
  buildSafeHostProcessRequest,
  decodeRedactedHostOutput,
} from "../src/hosts/process-policy.js";

const linuxPaths = createPlatformPathAdapter("linux");
const windowsPaths = createPlatformPathAdapter("win32");
const encoder = new TextEncoder();

function directExecutable(): HostExecutableAttestation {
  return validateHostExecutableAttestation({
    sourcePath: "/trusted/bin/claude",
    resolvedPath: "/trusted/bin/claude",
    revision: "executable-r1",
    chain: [
      {
        path: "/trusted/bin/claude",
        kind: "binary",
        owner: "trusted-system",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: "chain-r1",
      },
    ],
    launch: {
      executable: "/trusted/bin/claude",
      argumentPrefix: [],
      shell: false,
    },
  }, {
    host: "claude-code",
    scope: "user",
    excludedProjectDirectory: "/work/project",
  }, linuxPaths, "linux");
}

function windowsShimExecutable(): HostExecutableAttestation {
  return validateHostExecutableAttestation({
    sourcePath: "C:\\Trusted\\bin\\codex.cmd",
    resolvedPath: "C:\\Trusted\\lib\\codex.js",
    revision: "shim-r1",
    chain: [
      {
        path: "C:\\Trusted\\bin\\codex.cmd",
        kind: "shim",
        owner: "current-user",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "approved-npm-shim",
        revision: "cmd-r1",
      },
      {
        path: "C:\\Trusted\\lib\\codex.js",
        kind: "script",
        owner: "current-user",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: "script-r1",
      },
      {
        path: "C:\\Program Files\\nodejs\\node.exe",
        kind: "binary",
        owner: "trusted-system",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: "node-r1",
      },
    ],
    launch: {
      executable: "C:\\Program Files\\nodejs\\node.exe",
      argumentPrefix: ["C:\\Trusted\\lib\\codex.js"],
      shell: false,
    },
  }, {
    host: "codex",
    scope: "user",
    excludedProjectDirectory: "C:\\Work\\Project",
  }, windowsPaths, "win32");
}

const policy = {
  host: "claude-code" as const,
  neutralWorkingDirectory: "/isolated/neutral",
  excludedProjectDirectory: "/work/project",
  environment: {
    HOME: "/isolated/home",
    PATH: "/trusted/bin",
    NO_COLOR: "1",
  },
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
};

describe("safe host process policy", () => {
  it("builds a frozen direct-spawn request with no shell or stdin", () => {
    const request = buildSafeHostProcessRequest(
      directExecutable(),
      ["plugin", "list", "--json"],
      policy,
      linuxPaths,
      "linux",
    );
    expect(request).toEqual({
      executable: "/trusted/bin/claude",
      args: ["plugin", "list", "--json"],
      cwd: "/isolated/neutral",
      env: {
        HOME: "/isolated/home",
        PATH: "/trusted/bin",
        NO_COLOR: "1",
      },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      shell: false,
    });
    expect("stdin" in request).toBe(false);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.args)).toBe(true);
    expect(Object.isFrozen(request.env)).toBe(true);
  });

  it("turns an approved Windows shim into node plus argument-array execution", () => {
    const executable = windowsShimExecutable();
    const request = buildSafeHostProcessRequest(
      executable,
      ["--version"],
      {
        ...policy,
        host: "codex",
        neutralWorkingDirectory: "C:\\Isolated\\Neutral",
        excludedProjectDirectory: "C:\\Work\\Project",
        environment: {
          PATH: "C:\\Program Files\\nodejs",
          SystemRoot: "C:\\Windows",
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      },
      windowsPaths,
      "win32",
    );
    expect(request.executable).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(request.args).toEqual([
      "C:\\Trusted\\lib\\codex.js",
      "--version",
    ]);
    expect(request.shell).toBe(false);
  });

  it("turns an approved POSIX shim into attested node execution", () => {
    const executable = validateHostExecutableAttestation({
      sourcePath: "/trusted/bin/codex",
      resolvedPath: "/trusted/lib/codex.js",
      revision: "shim-r1",
      chain: [
        {
          path: "/trusted/bin/codex",
          kind: "shim",
          owner: "current-user",
          access: "not-broadly-writable",
          binding: "canonical",
          link: "approved-npm-shim",
          revision: "shim-link-r1",
        },
        {
          path: "/trusted/lib/codex.js",
          kind: "script",
          owner: "current-user",
          access: "not-broadly-writable",
          binding: "canonical",
          link: "direct",
          revision: "script-r1",
        },
        {
          path: "/trusted/bin/node",
          kind: "binary",
          owner: "trusted-system",
          access: "not-broadly-writable",
          binding: "canonical",
          link: "direct",
          revision: "node-r1",
        },
      ],
      launch: {
        executable: "/trusted/bin/node",
        argumentPrefix: ["/trusted/lib/codex.js"],
        shell: false,
      },
    }, {
      host: "codex",
      scope: "user",
      excludedProjectDirectory: "/work/project",
    }, linuxPaths, "linux");
    const request = buildSafeHostProcessRequest(
      executable,
      ["--version"],
      { ...policy, host: "codex" },
      linuxPaths,
      "linux",
    );
    expect(request.executable).toBe("/trusted/bin/node");
    expect(request.args).toEqual([
      "/trusted/lib/codex.js",
      "--version",
    ]);
    expect(request.shell).toBe(false);
  });

  it.each([
    {
      label: "project working directory",
      value: {
        ...policy,
        neutralWorkingDirectory: "/work/project",
      },
    },
    {
      label: "credential environment",
      value: {
        ...policy,
        environment: {
          ...policy.environment,
          PLURUM_API_KEY: "plrm_live_NEVER_ALLOWED",
        },
      },
    },
    {
      label: "unknown environment variable",
      value: {
        ...policy,
        environment: { ...policy.environment, NODE_OPTIONS: "--require=x" },
      },
    },
    {
      label: "oversized timeout",
      value: { ...policy, timeoutMs: 30_001 },
    },
    {
      label: "oversized output",
      value: { ...policy, maxOutputBytes: 1024 * 1024 + 1 },
    },
  ])("rejects $label", ({ value }) => {
    expect(() =>
      buildSafeHostProcessRequest(
        directExecutable(),
        ["--version"],
        value,
        linuxPaths,
        "linux",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_host_process_request" }),
    );
  });

  it("rejects secret-bearing arguments and a forged shell field", () => {
    for (const argument of [
      "--token=plrm_live_NEVER_ALLOWED",
      "--token=plrm_test_NEVER_ALLOWED",
      "--header=Bearer NEVER_ALLOWED",
      "--api-key=NEVER_ALLOWED",
      "--access_token:NEVER_ALLOWED",
      "--secret=NEVER_ALLOWED",
      "--password:NEVER_ALLOWED",
      "--source=https://user@example.invalid/plurum.git",
      "--key=-----BEGIN PRIVATE KEY-----",
    ]) {
      expect(() =>
        buildSafeHostProcessRequest(
          directExecutable(),
          [argument],
          policy,
          linuxPaths,
          "linux",
        ),
      ).toThrow(HostError);
    }

    expect(() =>
      buildSafeHostProcessRequest(
        directExecutable(),
        ["/isolated/secrets/plugin.json"],
        policy,
        linuxPaths,
        "linux",
      ),
    ).not.toThrow();

    const executable = {
      ...directExecutable(),
      launch: {
        ...directExecutable().launch,
        shell: true,
      },
    };
    expect(() =>
      buildSafeHostProcessRequest(
        executable as unknown as HostExecutableAttestation,
        ["--version"],
        policy,
        linuxPaths,
        "linux",
      ),
    ).toThrow(HostError);
  });

  it("revalidates a defensive executable copy without treating it as authority", () => {
    const copied = structuredClone(directExecutable());
    const request = buildSafeHostProcessRequest(
      copied,
      ["--version"],
      policy,
      linuxPaths,
      "linux",
    );

    expect(request.executable).toBe("/trusted/bin/claude");
    expect(request.args).toEqual(["--version"]);
    expect(request).not.toBe(copied);
  });

  it.each([
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HOME",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
  ])("rejects unsafe %s configuration paths", (name) => {
    for (const value of [
      "",
      "relative/config",
      "/work/project",
      "/work/project/config",
      "/isolated/../work/project",
      "//remote/config",
    ]) {
      expect(() =>
        buildSafeHostProcessRequest(
          directExecutable(),
          ["--version"],
          {
            ...policy,
            environment: {
              ...policy.environment,
              [name]: value,
            },
          },
          linuxPaths,
          "linux",
        ),
      ).toThrowError(
        expect.objectContaining({ code: "invalid_host_process_request" }),
      );
    }
  });

  it.each([
    "",
    ":/trusted/bin",
    "/trusted/bin:",
    "/trusted/bin::/trusted/bin",
    "./bin",
    "/trusted/../bin",
    "/work/project/bin",
    "/unattested/bin",
    "/trusted/bin:/trusted/bin",
    "/trusted/bin:/unattested/bin",
  ])("rejects unsafe or unattested POSIX PATH value %j", (path) => {
    expect(() =>
      buildSafeHostProcessRequest(
        directExecutable(),
        ["--version"],
        {
          ...policy,
          environment: {
            ...policy.environment,
            PATH: path,
          },
        },
        linuxPaths,
        "linux",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_host_process_request" }),
    );
  });

  it("rejects Windows-only launch variables on POSIX", () => {
    for (const environment of [
      { ...policy.environment, PATHEXT: ".EXE" },
      { ...policy.environment, SystemRoot: "/windows" },
      { ...policy.environment, WINDIR: "/windows" },
      { ...policy.environment, ComSpec: "/bin/sh" },
    ]) {
      expect(() =>
        buildSafeHostProcessRequest(
          directExecutable(),
          ["--version"],
          { ...policy, environment },
          linuxPaths,
          "linux",
        ),
      ).toThrowError(
        expect.objectContaining({ code: "invalid_host_process_request" }),
      );
    }
  });

  it("rejects unsafe Windows PATH, PATHEXT, and system launcher values", () => {
    const executable = windowsShimExecutable();
    const baseEnvironment = {
      PATH: "C:\\Program Files\\nodejs",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      APPDATA: "C:\\Users\\Agent\\AppData\\Roaming",
      TEMP: "C:\\Users\\Agent\\AppData\\Local\\Temp",
    };
    const invalidEnvironments = [
      { ...baseEnvironment, PATH: "C:\\Work\\Project\\bin" },
      { ...baseEnvironment, PATH: "C:\\Unattested\\bin" },
      { ...baseEnvironment, PATH: ".;C:\\Program Files\\nodejs" },
      {
        ...baseEnvironment,
        PATH: "C:\\Program Files\\nodejs;C:\\Program Files\\nodejs",
      },
      { ...baseEnvironment, PATHEXT: ".EXE;;.CMD" },
      { ...baseEnvironment, PATHEXT: ".EXE;.JS" },
      { ...baseEnvironment, PATHEXT: ".EXE;.exe" },
      { ...baseEnvironment, PATHEXT: ".CMD" },
      { ...baseEnvironment, ComSpec: "C:\\Work\\Project\\cmd.exe" },
      { ...baseEnvironment, ComSpec: "C:\\Windows\\cmd.exe" },
      { ...baseEnvironment, WINDIR: "C:\\OtherWindows" },
      { ...baseEnvironment, APPDATA: "C:\\Work\\Project\\config" },
      { ...baseEnvironment, TEMP: "relative\\temp" },
      { ...baseEnvironment, TEMP: "\\\\server\\share\\temp" },
    ];

    for (const environment of invalidEnvironments) {
      expect(() =>
        buildSafeHostProcessRequest(
          executable,
          ["--version"],
          {
            ...policy,
            host: "codex",
            neutralWorkingDirectory: "C:\\Isolated\\Neutral",
            excludedProjectDirectory: "C:\\Work\\Project",
            environment,
          },
          windowsPaths,
          "win32",
        ),
      ).toThrowError(
        expect.objectContaining({ code: "invalid_host_process_request" }),
      );
    }
  });
});

describe("streaming host output redaction", () => {
  it("redacts a sensitive value split at every byte boundary", () => {
    const key = "plrm_live_STREAMING_BOUNDARY_CANARY_0123456789";
    const input = encoder.encode(`before:${key}:after`);
    const original = input.slice();
    const redactor = new StreamingHostOutputRedactor(
      [encoder.encode(key)],
      4_096,
    );
    const chunks: Uint8Array[] = [];

    for (const byte of input) {
      chunks.push(redactor.push(new Uint8Array([byte])));
    }
    chunks.push(redactor.finish());
    const combined = new Uint8Array(
      chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
      expect(decodeRedactedHostOutput(chunk)).not.toContain(key);
    }

    expect(decodeRedactedHostOutput(combined)).toBe(
      "before:[REDACTED]:after",
    );
    expect(input).toEqual(original);
  });

  it("selects the longest matching sensitive value", () => {
    const redactor = new StreamingHostOutputRedactor(
      [encoder.encode("abcdefgh"), encoder.encode("abcdefghijkl")],
      1_024,
    );
    const output = [
      redactor.push(encoder.encode("xabcdefghijkl")),
      redactor.finish(),
    ];
    const combined = new Uint8Array(
      output.reduce((total, chunk) => total + chunk.byteLength, 0),
    );
    combined.set(output[0]!, 0);
    combined.set(output[1]!, output[0]!.byteLength);
    expect(decodeRedactedHostOutput(combined)).toBe("x[REDACTED]");
  });

  it("fails closed on output overflow and invalid UTF-8", () => {
    const redactor = new StreamingHostOutputRedactor(
      [encoder.encode("abcdefgh")],
      4,
    );
    expect(() => redactor.push(encoder.encode("123456789012"))).toThrowError(
      expect.objectContaining({ code: "host_output_too_large" }),
    );
    expect(() =>
      decodeRedactedHostOutput(new Uint8Array([0xc3, 0x28])),
    ).toThrowError(expect.objectContaining({ code: "host_output_invalid" }));
  });

  it("bounds cumulative raw output even when every chunk is redacted", () => {
    const sensitive = encoder.encode(
      "sensitive-value-longer-than-redaction",
    );
    const rawLimit = sensitive.byteLength * 4;
    const redactor = new StreamingHostOutputRedactor(
      [sensitive],
      rawLimit,
    );

    for (let index = 0; index < 4; index += 1) {
      expect(decodeRedactedHostOutput(redactor.push(sensitive))).toBe(
        "[REDACTED]",
      );
    }
    expect(() => redactor.push(sensitive)).toThrowError(
      expect.objectContaining({ code: "host_output_too_large" }),
    );
  });

  it("cannot be reused after finish", () => {
    const redactor = new StreamingHostOutputRedactor(
      [encoder.encode("abcdefgh")],
      1_024,
    );
    redactor.finish();
    expect(() => redactor.push(encoder.encode("safe"))).toThrow(HostError);
    expect(() => redactor.finish()).toThrow(HostError);
  });
});
