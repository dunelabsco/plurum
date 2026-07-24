import { describe, expect, it } from "vitest";

import {
  createNativeCodexDotenvAdapter,
  type NativeCodexDotenvRawCalls,
} from "../src/adapters/node/native-codex-dotenv.js";
import {
  CODEX_DOTENV_API_ORIGIN,
  type CodexDotenvNativeAdapter,
} from "../src/credentials/codex-dotenv-contracts.js";
import { parseApiKey } from "../src/credentials/schema.js";

const PROJECT = "/isolated/project";
const KEY = parseApiKey(`plrm_live_${"A".repeat(43)}`);
const OTHER_KEY = `plrm_live_${"B".repeat(43)}`;
const REVISION_1 = "1".repeat(64);
const REVISION_2 = "2".repeat(64);
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

type FakeState =
  | Readonly<{
      status: "missing" | "oversized" | "unsafe";
      revision: string;
    }>
  | Readonly<{
      status: "present";
      revision: string;
      bytes: Uint8Array;
    }>;

function copy(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function fakeRaw(initial: FakeState): Readonly<{
  raw: NativeCodexDotenvRawCalls;
  observations: readonly unknown[];
  synchronizations: readonly unknown[];
  exposedReads: readonly Uint8Array[];
  exposedWrites: readonly Uint8Array[];
  installedWrites: readonly Uint8Array[];
  setState(value: FakeState): void;
}> {
  let state = initial;
  const observations: unknown[] = [];
  const synchronizations: unknown[] = [];
  const exposedReads: Uint8Array[] = [];
  const exposedWrites: Uint8Array[] = [];
  const installedWrites: Uint8Array[] = [];
  const raw = Object.freeze({
    observe(options: unknown) {
      observations.push(options);
      if (state.status !== "present") {
        return Object.freeze({
          status: state.status,
          revision: state.revision,
        });
      }
      const bytes = copy(state.bytes);
      exposedReads.push(bytes);
      return Object.freeze({
        status: "present" as const,
        revision: state.revision,
        read: Object.freeze({
          bytes,
          endOfFile: true,
        }),
      });
    },
    synchronize(options: unknown) {
      synchronizations.push(options);
      if (options === null || typeof options !== "object") {
        throw new Error("invalid fake request");
      }
      const request = options as {
        readonly bytes?: Uint8Array;
        readonly disposition: "changed" | "unchanged";
        readonly expectedRevision: string;
        readonly nextRevisionNonce: string;
      };
      if (request.expectedRevision !== state.revision) {
        return Object.freeze({ status: "precondition-failed" as const });
      }
      if (request.disposition === "unchanged") {
        return Object.freeze({
          status: "completed" as const,
          disposition: "unchanged" as const,
          stateRevision: state.revision,
        });
      }
      if (request.bytes === undefined) {
        throw new Error("missing fake bytes");
      }
      exposedWrites.push(request.bytes);
      const installed = copy(request.bytes);
      installedWrites.push(installed);
      state = Object.freeze({
        status: "present",
        revision: request.nextRevisionNonce,
        bytes: installed,
      });
      return Object.freeze({
        status: "completed" as const,
        disposition: "changed" as const,
        stateRevision: request.nextRevisionNonce,
      });
    },
  }) satisfies NativeCodexDotenvRawCalls;
  return {
    raw,
    observations,
    synchronizations,
    exposedReads,
    exposedWrites,
    installedWrites,
    setState(value) {
      state = value;
    },
  };
}

function observeRequest(
  expectation:
    | Readonly<{ kind: "known"; apiKey: typeof KEY }>
    | Readonly<{ kind: "deferred-registration" }> = Object.freeze({
    kind: "known",
    apiKey: KEY,
  }),
) {
  return Object.freeze({
    kind: "codex-dotenv-observe" as const,
    scope: "user" as const,
    apiOrigin: CODEX_DOTENV_API_ORIGIN,
    expectation,
    excludedProjectDirectory: PROJECT,
  });
}

function synchronizeRequest(
  before: Awaited<ReturnType<CodexDotenvNativeAdapter["observe"]>>,
) {
  if (
    before.status !== "absent" &&
    before.status !== "exact" &&
    before.status !== "mismatched"
  ) {
    throw new Error("test state is not synchronizable");
  }
  return Object.freeze({
    kind: "codex-dotenv-synchronize" as const,
    scope: "user" as const,
    apiOrigin: CODEX_DOTENV_API_ORIGIN,
    expectedRevision: before.revision,
    expectedStatus: before.status,
    expectation: Object.freeze({ kind: "known" as const, apiKey: KEY }),
    excludedProjectDirectory: PROJECT,
  });
}

describe("native Codex dotenv semantic adapter", () => {
  it("classifies missing, unsafe, and oversized native states without exposing paths or bytes", async () => {
    for (const [rawStatus, semanticStatus] of [
      ["missing", "absent"],
      ["unsafe", "unsafe"],
      ["oversized", "ambiguous"],
    ] as const) {
      const fake = fakeRaw(
        Object.freeze({ status: rawStatus, revision: REVISION_1 }),
      );
      const adapter = createNativeCodexDotenvAdapter(fake.raw, "lf");

      await expect(adapter.observe(observeRequest())).resolves.toEqual({
        revision: REVISION_1,
        status: semanticStatus,
      });
      expect(fake.observations).toHaveLength(1);
      expect(fake.observations[0]).toMatchObject({
        excludedProjectDirectory: PROJECT,
        maxBytes: 128 * 1024,
        noFollow: true,
      });
      expect(
        (fake.observations[0] as { revisionNonce: string }).revisionNonce,
      ).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("uses the same parser for deferred absence, presence, and ambiguity", async () => {
    for (const [text, status] of [
      ["OTHER=value\n", "absent"],
      [`PLURUM_API_KEY=${OTHER_KEY}\n`, "mismatched"],
      [
        `PLURUM_API_KEY=${OTHER_KEY}\nPLURUM_API_KEY=${OTHER_KEY}\n`,
        "ambiguous",
      ],
    ] as const) {
      const fake = fakeRaw(
        Object.freeze({
          status: "present",
          revision: REVISION_1,
          bytes: ENCODER.encode(text),
        }),
      );
      const adapter = createNativeCodexDotenvAdapter(fake.raw, "lf");

      await expect(
        adapter.observe(
          observeRequest(
            Object.freeze({ kind: "deferred-registration" }),
          ),
        ),
      ).resolves.toEqual({ revision: REVISION_1, status });
      const exposedRead = fake.exposedReads[0];
      expect(exposedRead).toBeDefined();
      expect(exposedRead).toEqual(
        new Uint8Array(exposedRead?.byteLength ?? 0),
      );
    }
  });

  it("preserves BOM, comments, quoting, ordering, and CRLF while replacing only the selected key", async () => {
    const original = ENCODER.encode(
      `\uFEFF# keep\r\nOTHER="secret"\r\nexport PLURUM_API_KEY = '${OTHER_KEY}' # keep\r\nLAST=value\r\n`,
    );
    const fake = fakeRaw(
      Object.freeze({
        status: "present",
        revision: REVISION_1,
        bytes: original,
      }),
    );
    const adapter = createNativeCodexDotenvAdapter(fake.raw, "crlf");
    const before = await adapter.observe(observeRequest());
    expect(before).toEqual({
      revision: REVISION_1,
      status: "mismatched",
    });

    const result = await adapter.synchronize(synchronizeRequest(before));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error("expected completed synchronization");
    }
    expect(result.disposition).toBe("changed");
    expect(result.stateRevision).not.toBe(REVISION_1);
    expect(fake.installedWrites).toHaveLength(1);
    expect(fake.installedWrites[0]?.subarray(0, 3)).toEqual(
      Uint8Array.of(0xef, 0xbb, 0xbf),
    );
    expect(DECODER.decode(fake.installedWrites[0]?.subarray(3))).toBe(
      `# keep\r\nOTHER="secret"\r\nexport PLURUM_API_KEY = '${KEY}' # keep\r\nLAST=value\r\n`,
    );
    const exposedWrite = fake.exposedWrites[0];
    expect(exposedWrite).toBeDefined();
    expect(exposedWrite).toEqual(
      new Uint8Array(exposedWrite?.byteLength ?? 0),
    );
    for (const bytes of fake.exposedReads) {
      expect(bytes).toEqual(new Uint8Array(bytes.byteLength));
    }
  });

  it("confirms an exact projection without rewriting its bytes or revision", async () => {
    const file = ENCODER.encode(`PLURUM_API_KEY=${KEY}\n`);
    const fake = fakeRaw(
      Object.freeze({
        status: "present",
        revision: REVISION_1,
        bytes: file,
      }),
    );
    const adapter = createNativeCodexDotenvAdapter(fake.raw, "lf");
    const before = await adapter.observe(observeRequest());
    expect(before.status).toBe("exact");

    await expect(
      adapter.synchronize(synchronizeRequest(before)),
    ).resolves.toEqual({
      status: "completed",
      disposition: "unchanged",
      stateRevision: REVISION_1,
    });
    expect(fake.installedWrites).toEqual([]);
    expect(fake.synchronizations).toHaveLength(1);
    expect(fake.synchronizations[0]).not.toHaveProperty("bytes");
  });

  it("appends with the platform newline when the file or target assignment is absent", async () => {
    for (const [initial, newline] of [
      [
        Object.freeze({
          status: "missing" as const,
          revision: REVISION_1,
        }),
        "\r\n",
      ],
      [
        Object.freeze({
          status: "present" as const,
          revision: REVISION_1,
          bytes: ENCODER.encode("OTHER=value"),
        }),
        "\r\n",
      ],
    ] as const) {
      const fake = fakeRaw(initial);
      const adapter = createNativeCodexDotenvAdapter(fake.raw, "crlf");
      const before = await adapter.observe(observeRequest());
      expect(before.status).toBe("absent");

      await adapter.synchronize(synchronizeRequest(before));

      expect(DECODER.decode(fake.installedWrites[0])).toBe(
        initial.status === "missing"
          ? `PLURUM_API_KEY=${KEY}${newline}`
          : `OTHER=value${newline}PLURUM_API_KEY=${KEY}`,
      );
    }
  });

  it("fails the compare-and-swap when the native state changes between inspection and synchronization", async () => {
    const fake = fakeRaw(
      Object.freeze({ status: "missing", revision: REVISION_1 }),
    );
    const adapter = createNativeCodexDotenvAdapter(fake.raw, "lf");
    const before = await adapter.observe(observeRequest());
    fake.setState(
      Object.freeze({ status: "missing", revision: REVISION_2 }),
    );

    await expect(
      adapter.synchronize(synchronizeRequest(before)),
    ).resolves.toEqual({ status: "precondition-failed" });
    expect(fake.synchronizations).toEqual([]);
  });

  it("wipes raw present bytes before rejecting malformed native read results", async () => {
    for (const fixture of [
      {
        readResult: (bytes: Uint8Array) =>
          Object.freeze({
            bytes,
            endOfFile: false,
          }),
        outerExtra: {},
      },
      {
        readResult: (bytes: Uint8Array) =>
          Object.freeze({
            bytes,
            endOfFile: true,
            unexpected: "field",
          }),
        outerExtra: {},
      },
      {
        readResult: (bytes: Uint8Array) =>
          Object.freeze({
            bytes,
            endOfFile: true,
        }),
        outerExtra: { unexpected: "field" },
      },
      {
        readResult: (bytes: Uint8Array) =>
          Object.freeze({
            bytes,
            endOfFile: true,
            [Symbol("unexpected")]: "field",
          }),
        outerExtra: {},
      },
      {
        readResult: (bytes: Uint8Array) => {
          const read = {
            bytes,
            endOfFile: true,
          };
          Object.defineProperty(read, "unexpected", {
            configurable: false,
            enumerable: false,
            value: "field",
            writable: false,
          });
          return Object.freeze(read);
        },
        outerExtra: {},
      },
    ] as const) {
      const rawBytes = ENCODER.encode(`PLURUM_API_KEY=${OTHER_KEY}\n`);
      const malformed = createNativeCodexDotenvAdapter(
        Object.freeze({
          observe() {
            return Object.freeze({
              status: "present",
              revision: REVISION_1,
              read: fixture.readResult(rawBytes),
              ...fixture.outerExtra,
            });
          },
          synchronize() {
            return Object.freeze({ status: "failed" });
          },
        }),
        "lf",
      );

      await expect(malformed.observe(observeRequest())).rejects.toThrow(
        "native Codex credential projection failed",
      );
      expect(rawBytes).toEqual(new Uint8Array(rawBytes.byteLength));
    }
  });

  it("fails closed on non-exact requests and malformed raw results", async () => {
    const fake = fakeRaw(
      Object.freeze({ status: "missing", revision: REVISION_1 }),
    );
    const adapter = createNativeCodexDotenvAdapter(fake.raw, "lf");
    await expect(
      adapter.observe({
        ...observeRequest(),
        apiOrigin: "https://example.invalid" as typeof CODEX_DOTENV_API_ORIGIN,
      }),
    ).rejects.toThrow("native Codex credential projection failed");

    const malformed = createNativeCodexDotenvAdapter(
      Object.freeze({
        observe() {
          return Object.freeze({
            status: "missing",
            revision: `plrm_live_${"S".repeat(43)}`,
          });
        },
        synchronize() {
          return Object.freeze({ status: "failed" });
        },
      }),
      "lf",
    );
    await expect(malformed.observe(observeRequest())).rejects.toThrow(
      "native Codex credential projection failed",
    );
  });
});
