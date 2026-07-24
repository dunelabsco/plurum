import { describe, expect, it } from "vitest";

import {
  RECOGNIZED_RUNTIME_TARGETS,
  RELEASED_RUNTIME_TARGETS,
  SUPPORTED_NODE_RUNTIME_RANGES,
  observeRuntimePlatformSupport,
  type RuntimeSupportObservation,
  type RuntimeSupportObservationAdapter,
} from "../src/system/runtime-support.js";

const SECRET = "plrm_live_RUNTIME_SUPPORT_SECRET_DO_NOT_PRINT";

function adapter(
  observation: RuntimeSupportObservation,
): RuntimeSupportObservationAdapter {
  return Object.freeze({
    async observe() {
      return observation;
    },
  });
}

describe("runtime and platform support", () => {
  it("locks the recognized and released target sets without treating every reserved target as released", () => {
    expect(RECOGNIZED_RUNTIME_TARGETS).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64-gnu",
      "linux-arm64-musl",
      "linux-x64-gnu",
      "linux-x64-musl",
      "win32-arm64-msvc",
      "win32-x64-msvc",
    ]);
    expect(RELEASED_RUNTIME_TARGETS).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64-gnu",
      "linux-x64-gnu",
      "win32-x64-msvc",
    ]);
    expect(SUPPORTED_NODE_RUNTIME_RANGES).toEqual([
      "^22.12.0",
      "^24.0.0",
    ]);
    expect(Object.isFrozen(RECOGNIZED_RUNTIME_TARGETS)).toBe(true);
    expect(Object.isFrozen(RELEASED_RUNTIME_TARGETS)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_NODE_RUNTIME_RANGES)).toBe(true);
  });

  it.each([
    ["22.12.0", "darwin-arm64"],
    ["22.12.1", "darwin-x64"],
    ["22.1000.0", "linux-arm64-gnu"],
    ["24.0.0", "linux-x64-gnu"],
    ["24.999.999", "win32-x64-msvc"],
  ] as const)("accepts supported Node %s on released target %s", async (version, target) => {
    const result = await observeRuntimePlatformSupport(
      adapter(Object.freeze({ status: "available", runtime: "node", version, target })),
    );

    expect(result).toEqual({
      status: "supported",
      runtime: "node",
      version,
      target,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(["20.19.0", "22.11.999", "23.0.0", "25.0.0"])(
    "reports canonical Node %s as unsupported rather than unavailable",
    async (version) => {
      const result = await observeRuntimePlatformSupport(
        adapter(
          Object.freeze({
            status: "available",
            runtime: "node",
            version,
            target: "darwin-arm64",
          }),
        ),
      );

      expect(result).toEqual({
        status: "unsupported",
        reason: "node-version",
        runtime: "node",
        version,
        target: "darwin-arm64",
      });
    },
  );

  it.each([
    "linux-arm64-musl",
    "linux-x64-musl",
    "win32-arm64-msvc",
  ] as const)(
    "recognizes but does not overclaim unreleased target %s",
    async (target) => {
      await expect(
        observeRuntimePlatformSupport(
          adapter(
            Object.freeze({
              status: "available",
              runtime: "node",
              version: "22.12.0",
              target,
            }),
          ),
        ),
      ).resolves.toEqual({
        status: "unsupported",
        reason: "platform-target",
        runtime: "node",
        version: "22.12.0",
        target,
      });
    },
  );

  it("reports an unknown but well-formed target without reflecting it", async () => {
    const result = await observeRuntimePlatformSupport(
      adapter(
        Object.freeze({
          status: "available",
          runtime: "node",
          version: "24.0.0",
          target: "freebsd-x64",
        }),
      ),
    );

    expect(result).toEqual({
      status: "unsupported",
      reason: "platform-target",
      runtime: "node",
      version: "24.0.0",
      target: null,
    });
    expect(JSON.stringify(result)).not.toContain("freebsd");
  });

  it("preserves the exact adapter receiver while exposing no other operation", async () => {
    let observedReceiver: unknown;
    const exactAdapter = Object.freeze<RuntimeSupportObservationAdapter>({
      async observe() {
        observedReceiver = this;
        return Object.freeze({
          status: "available" as const,
          runtime: "node" as const,
          version: "22.12.0",
          target: "darwin-arm64",
        });
      },
    });

    await expect(
      observeRuntimePlatformSupport(exactAdapter),
    ).resolves.toMatchObject({ status: "supported" });
    expect(observedReceiver).toBe(exactAdapter);
    expect(Object.keys(exactAdapter)).toEqual(["observe"]);
  });

  it("maps explicit or thrown observation failure to one fixed unavailable result", async () => {
    const explicit = await observeRuntimePlatformSupport(
      adapter(Object.freeze({ status: "unavailable" })),
    );
    const thrown = await observeRuntimePlatformSupport(
      Object.freeze({
        async observe(): Promise<RuntimeSupportObservation> {
          throw new Error(SECRET);
        },
      }),
    );

    for (const result of [explicit, thrown]) {
      expect(result).toEqual({
        status: "unavailable",
        reason: "observation-unavailable",
        runtime: null,
        version: null,
        target: null,
      });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it.each([
    null,
    Object.freeze({}),
    Object.freeze({ status: "available", runtime: "node", version: "22.12.0" }),
    Object.freeze({
      status: "available",
      runtime: "node",
      version: "22.12.0-beta.1",
      target: "darwin-arm64",
    }),
    Object.freeze({
      status: "available",
      runtime: "node",
      version: "22.12.0",
      target: `darwin-arm64-${SECRET}`,
    }),
    Object.freeze({
      status: "available",
      runtime: "node",
      version: "22.12.0",
      target: "darwin-arm64",
      extra: true,
    }),
    Object.create({
      status: "available",
      runtime: "node",
      version: "22.12.0",
      target: "darwin-arm64",
    }),
  ])("fails closed for a malformed observation", async (observation) => {
    const result = await observeRuntimePlatformSupport(
      Object.freeze({
        async observe() {
          return observation as RuntimeSupportObservation;
        },
      }),
    );

    expect(result).toEqual({
      status: "unavailable",
      reason: "observation-unavailable",
      runtime: null,
      version: null,
      target: null,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("rejects adapter and observation accessors without invoking them", async () => {
    let adapterReads = 0;
    let observationReads = 0;
    const accessorAdapter = Object.defineProperty({}, "observe", {
      enumerable: true,
      get() {
        adapterReads += 1;
        throw new Error(SECRET);
      },
    }) as RuntimeSupportObservationAdapter;
    const accessorObservation = Object.defineProperty(
      {
        status: "available",
        runtime: "node",
        target: "darwin-arm64",
      },
      "version",
      {
        enumerable: true,
        get() {
          observationReads += 1;
          throw new Error(SECRET);
        },
      },
    );

    await expect(
      observeRuntimePlatformSupport(accessorAdapter),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      observeRuntimePlatformSupport(
        Object.freeze({
          async observe() {
            return accessorObservation as RuntimeSupportObservation;
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(adapterReads).toBe(0);
    expect(observationReads).toBe(0);
  });

  it("rejects an adapter carrying additional authority before calling it", async () => {
    let called = false;
    const overpowered = Object.freeze({
      async observe() {
        called = true;
        return Object.freeze({
          status: "available" as const,
          runtime: "node" as const,
          version: "22.12.0",
          target: "darwin-arm64",
        });
      },
      mutate() {
        throw new Error(SECRET);
      },
    });

    await expect(
      observeRuntimePlatformSupport(
        overpowered as unknown as RuntimeSupportObservationAdapter,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(called).toBe(false);
  });
});
