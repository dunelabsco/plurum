import { describe, expect, it } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import {
  LEGACY_CREDENTIAL_SOURCE_IDS,
  resolveLegacyCredentialPaths,
  type CredentialDiscoveryEnvironment,
} from "../src/credentials/discovery-paths.js";
import { CredentialError } from "../src/credentials/errors.js";
import type {
  PlatformAdapter,
  RuntimeEnvironment,
  SupportedOs,
} from "../src/system/contracts.js";

function fakePlatform(
  os: SupportedOs,
  environment: RuntimeEnvironment,
): PlatformAdapter {
  return Object.freeze({
    os,
    arch: "test",
    cwd: os === "win32" ? "C:\\workspace" : "/workspace",
    environment: Object.freeze({ ...environment }),
    elevation: "standard",
    paths: createPlatformPathAdapter(os),
  });
}

function resolve(
  os: SupportedOs,
  environment: RuntimeEnvironment,
  discoveryEnvironment: CredentialDiscoveryEnvironment = {},
) {
  return resolveLegacyCredentialPaths(
    fakePlatform(os, environment),
    discoveryEnvironment,
  );
}

describe("legacy credential discovery paths", () => {
  it("exports stable source IDs and resolves exact POSIX defaults", () => {
    expect(LEGACY_CREDENTIAL_SOURCE_IDS).toEqual([
      "hermes",
      "openclaw",
      "removed-cli",
    ]);
    expect(Object.isFrozen(LEGACY_CREDENTIAL_SOURCE_IDS)).toBe(true);
    const paths = resolve("darwin", { HOME: "/Users/example" });
    expect(paths).toEqual([
      {
        source: "hermes",
        path: "/Users/example/.hermes/plurum.json",
      },
      {
        source: "openclaw",
        path: "/Users/example/.openclaw/plurum.json",
      },
      {
        source: "removed-cli",
        path: "/Users/example/.plurum/config.json",
      },
    ]);
    expect(Object.isFrozen(paths)).toBe(true);
    expect(paths.every(Object.isFrozen)).toBe(true);
  });

  it("uses only exact explicit host-home overrides", () => {
    expect(
      resolve(
        "linux",
        { HOME: "/home/example" },
        {
          HERMES_HOME: "/srv/hermes-profile",
          OPENCLAW_HOME: "/srv/openclaw-home",
        },
      ),
    ).toEqual([
      {
        source: "hermes",
        path: "/srv/hermes-profile/plurum.json",
      },
      {
        source: "openclaw",
        path: "/srv/openclaw-home/.openclaw/plurum.json",
      },
      {
        source: "removed-cli",
        path: "/home/example/.plurum/config.json",
      },
    ]);
  });

  it("uses Local AppData for Hermes and the OS home for other Windows sources", () => {
    expect(
      resolve("win32", {
        LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
        USERPROFILE: "C:\\Users\\example",
      }),
    ).toEqual([
      {
        source: "hermes",
        path: "C:\\Users\\example\\AppData\\Local\\hermes\\plurum.json",
      },
      {
        source: "openclaw",
        path: "C:\\Users\\example\\.openclaw\\plurum.json",
      },
      {
        source: "removed-cli",
        path: "C:\\Users\\example\\.plurum\\config.json",
      },
    ]);
  });

  it("falls back from empty Local AppData and empty overrides", () => {
    expect(
      resolve(
        "win32",
        {
          LOCALAPPDATA: "",
          USERPROFILE: "C:\\Users\\example",
        },
        { HERMES_HOME: "", OPENCLAW_HOME: "" },
      ),
    ).toEqual([
      {
        source: "hermes",
        path: "C:\\Users\\example\\AppData\\Local\\hermes\\plurum.json",
      },
      {
        source: "openclaw",
        path: "C:\\Users\\example\\.openclaw\\plurum.json",
      },
      {
        source: "removed-cli",
        path: "C:\\Users\\example\\.plurum\\config.json",
      },
    ]);
  });

  it.each([
    ["unsupported", {}],
    ["darwin", {}],
    ["darwin", { HOME: "relative/home" }],
    ["darwin", { HOME: "/" }],
    ["darwin", { HOME: "/home/../escape" }],
    ["darwin", { HOME: "/home/control\u0000value" }],
    ["linux", { HOME: "//ambiguous/home" }],
    ["win32", { USERPROFILE: "C:relative" }],
    ["win32", { USERPROFILE: "\\rooted-without-drive" }],
    ["win32", { USERPROFILE: "C:\\" }],
    ["win32", { USERPROFILE: "\\\\?\\C:\\Users\\example" }],
    ["win32", { USERPROFILE: "\\\\.\\C:\\Users\\example" }],
    ["win32", { USERPROFILE: "\\\\server\\profiles\\example" }],
    ["win32", { USERPROFILE: "C:\\Users\\example:stream" }],
    ["win32", { USERPROFILE: "C:\\Users\\CON" }],
    ["win32", { USERPROFILE: "C:\\Users\\example." }],
    ["win32", { USERPROFILE: "C:\\Users\\bad?name" }],
    ["win32", { USERPROFILE: "\\\\server\\pipe\\credential" }],
    ["win32", { USERPROFILE: "\\\\server\\MAILSLOT\\credential" }],
    ["win32", { USERPROFILE: "\\\\server\\IPC$\\credential" }],
  ] as const)("rejects invalid %s OS-home input %#", (os, environment) => {
    expect(() =>
      resolve(os as SupportedOs, environment as RuntimeEnvironment),
    ).toThrow(CredentialError);
  });

  it.each([
    { HERMES_HOME: "relative" },
    { HERMES_HOME: "/" },
    { HERMES_HOME: "/srv/../escape" },
    { HERMES_HOME: "/srv/control\nvalue" },
    { OPENCLAW_HOME: "relative" },
    { OPENCLAW_HOME: "/" },
    { OPENCLAW_HOME: "/srv/../escape" },
    { OPENCLAW_HOME: "/srv/control\u007fvalue" },
  ])("rejects invalid POSIX host override %#", (discoveryEnvironment) => {
    expect(() =>
      resolve("linux", { HOME: "/home/example" }, discoveryEnvironment),
    ).toThrow(CredentialError);
  });

  it.each([
    { HERMES_HOME: "C:relative" },
    { HERMES_HOME: "\\\\?\\C:\\Hermes" },
    { HERMES_HOME: "C:\\Users\\example\\..\\escape" },
    { HERMES_HOME: "C:\\Users\\NUL\\Hermes" },
    { OPENCLAW_HOME: "\\rooted-without-drive" },
    { OPENCLAW_HOME: "\\\\.\\C:\\OpenClaw" },
    { OPENCLAW_HOME: "C:\\Users\\example:stream" },
    { OPENCLAW_HOME: "C:\\Users\\bad*name" },
  ])("rejects invalid Windows host override %#", (discoveryEnvironment) => {
    expect(() =>
      resolve(
        "win32",
        { USERPROFILE: "C:\\Users\\example" },
        discoveryEnvironment,
      ),
    ).toThrow(CredentialError);
  });

  it.each([
    "C:relative",
    "\\rooted-without-drive",
    "C:\\",
    "\\\\?\\C:\\Users\\example\\AppData\\Local",
    "\\\\.\\C:\\Users\\example\\AppData\\Local",
    "C:\\Users\\example\\AppData\\..\\escape",
    "C:\\Users\\example\\NUL\\Local",
    "C:\\Users\\example\\bad|name",
    "\\\\server\\pipe\\credential",
  ])("rejects invalid Windows Local AppData %s", (localAppData) => {
    expect(() =>
      resolve("win32", {
        LOCALAPPDATA: localAppData,
        USERPROFILE: "C:\\Users\\example",
      }),
    ).toThrow(CredentialError);
  });

  it("keeps every test-mode path strictly inside the sentinel root", () => {
    const paths = resolve(
      "linux",
      {
        HOME: "/isolated/home",
        PLURUM_HOME: "/isolated/plurum",
        PLURUM_TEST_ROOT: "/isolated",
        PLURUM_TEST_RUN_ID: "test-run-0001",
      },
      {
        HERMES_HOME: "/isolated/hermes",
        OPENCLAW_HOME: "/isolated/openclaw-home",
      },
    );
    expect(paths.every(({ path }) => path.startsWith("/isolated/"))).toBe(true);
  });

  it("confines Windows test paths to the sentinel root", () => {
    const paths = resolve(
      "win32",
      {
        LOCALAPPDATA: "C:\\isolated\\local",
        USERPROFILE: "C:\\isolated\\home",
        PLURUM_HOME: "C:\\isolated\\plurum",
        PLURUM_TEST_ROOT: "C:\\isolated",
        PLURUM_TEST_RUN_ID: "test-run-0001",
      },
      {
        HERMES_HOME: "C:\\isolated\\hermes",
        OPENCLAW_HOME: "C:\\isolated\\openclaw-home",
      },
    );
    expect(
      paths.every(({ path }) =>
        path.toLowerCase().startsWith("c:\\isolated\\"),
      ),
    ).toBe(true);
  });

  it.each([
    {
      environment: {
        HOME: "/isolated/home",
        PLURUM_HOME: "/isolated/plurum",
        PLURUM_TEST_ROOT: "/isolated",
        PLURUM_TEST_RUN_ID: "test-run-0001",
      },
      discovery: { HERMES_HOME: "/outside/hermes" },
    },
    {
      environment: {
        HOME: "/outside/home",
        PLURUM_HOME: "/isolated/plurum",
        PLURUM_TEST_ROOT: "/isolated",
        PLURUM_TEST_RUN_ID: "test-run-0001",
      },
      discovery: {},
    },
    {
      environment: {
        HOME: "/isolated/home",
        PLURUM_HOME: "/outside/plurum",
        PLURUM_TEST_ROOT: "/isolated",
        PLURUM_TEST_RUN_ID: "test-run-0001",
      },
      discovery: {},
    },
    {
      environment: {
        HOME: "/isolated/home",
        PLURUM_TEST_ROOT: "/isolated",
        PLURUM_TEST_RUN_ID: "test-run-0001",
      },
      discovery: {},
    },
    {
      environment: {
        HOME: "/isolated/home",
        PLURUM_HOME: "/isolated/plurum",
        PLURUM_TEST_ROOT: "/isolated",
        PLURUM_TEST_RUN_ID: "short",
      },
      discovery: {},
    },
  ])(
    "rejects escaping or incomplete test state %#",
    ({ environment, discovery }) => {
      expect(() =>
        resolve("linux", environment, discovery),
      ).toThrow(CredentialError);
    },
  );
});
