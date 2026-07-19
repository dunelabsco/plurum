import { describe, expect, it } from "vitest";

import {
  NATIVE_CREDENTIAL_STORE_ABI_VERSION,
  NATIVE_CREDENTIAL_STORE_MAGIC,
  NATIVE_CREDENTIAL_STORE_NODE_API_VERSION,
  NATIVE_CREDENTIAL_TARGET_IDS,
  createNativeCredentialStoreProvider,
  type NativeCredentialModuleResolver,
  type NativeCredentialStoreProvider,
  type NativeCredentialTarget,
} from "../src/adapters/node/native-credential-store.js";
import { CLI_VERSION } from "../src/version.js";
import type {
  CredentialStoreMutationAdapter,
  CredentialStoreMutationLease,
  CredentialSetupLeaseNonce,
} from "../src/credentials/store-mutation-contracts.js";
import type {
  CredentialStoreReadAdapter,
  PrivateCredentialDirectoryHandle,
} from "../src/credentials/store-contracts.js";

const TARGET = "darwin-arm64" satisfies NativeCredentialTarget;
const SECRET_SENTINEL = "plrm_live_NATIVE_PROVIDER_SECRET_SENTINEL";

function createNativeModule(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const read: CredentialStoreReadAdapter = Object.freeze({
    async openPrivateDirectory() {
      return { status: "missing" as const };
    },
  });
  const mutation: CredentialStoreMutationAdapter = Object.freeze({
    async acquireSetupLease() {
      return { status: "busy" as const };
    },
  });

  return {
    magic: NATIVE_CREDENTIAL_STORE_MAGIC,
    abiVersion: NATIVE_CREDENTIAL_STORE_ABI_VERSION,
    nodeApiVersion: NATIVE_CREDENTIAL_STORE_NODE_API_VERSION,
    packageVersion: CLI_VERSION,
    target: TARGET,
    createAdapters() {
      return { read, mutation };
    },
    ...overrides,
  };
}

function resolverReturning(value: unknown): NativeCredentialModuleResolver {
  return () => value;
}

describe("native credential store provider", () => {
  it("defines the deliberately narrow reserved target identifiers", () => {
    expect(NATIVE_CREDENTIAL_TARGET_IDS).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64-gnu",
      "linux-arm64-musl",
      "linux-x64-gnu",
      "linux-x64-musl",
      "win32-arm64-msvc",
      "win32-x64-msvc",
    ]);
    expect(Object.isFrozen(NATIVE_CREDENTIAL_TARGET_IDS)).toBe(true);
  });

  it("does not resolve or instantiate a native module until explicitly loaded", () => {
    let resolveCalls = 0;
    let factoryCalls = 0;
    const module = createNativeModule({
      createAdapters() {
        factoryCalls += 1;
        return {
          read: {
            async openPrivateDirectory() {
              return { status: "missing" as const };
            },
          },
          mutation: {
            async acquireSetupLease() {
              return { status: "busy" as const };
            },
          },
        };
      },
    });
    const provider = createNativeCredentialStoreProvider(
      TARGET,
      (target) => {
        resolveCalls += 1;
        expect(target).toBe(TARGET);
        return module;
      },
    );

    expect(resolveCalls).toBe(0);
    expect(factoryCalls).toBe(0);

    const loaded = provider.load();

    expect(loaded.status).toBe("available");
    expect(resolveCalls).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(provider.load()).toBe(loaded);
    expect(resolveCalls).toBe(1);
    expect(factoryCalls).toBe(1);
  });

  it("captures the resolver value without resolving the module", () => {
    let resolveCalls = 0;
    const originalResolver: NativeCredentialModuleResolver = () => {
      resolveCalls += 1;
      return createNativeModule();
    };
    const replacementResolver: NativeCredentialModuleResolver = () => {
      throw new Error(SECRET_SENTINEL);
    };
    let selectedResolver = originalResolver;
    const provider = createNativeCredentialStoreProvider(
      TARGET,
      selectedResolver,
    );

    selectedResolver = replacementResolver;

    expect(resolveCalls).toBe(0);
    expect(provider.load().status).toBe("available");
    expect(resolveCalls).toBe(1);
    expect(selectedResolver).toBe(replacementResolver);
  });

  it("wraps and freezes only the two high-level credential adapters", async () => {
    const calls: string[] = [];
    const directoryResult = {
      status: "opened" as const,
      directory: {} as PrivateCredentialDirectoryHandle,
    };
    const leaseResult = {
      status: "acquired" as const,
      priorLease: "absent" as const,
      directory: "created" as const,
      lease: {} as CredentialStoreMutationLease,
    };
    const rawRead = {
      marker: "read",
      async openPrivateDirectory(
        this: { marker: string },
        directory: string,
        options: { readonly noFollow: true },
      ) {
        calls.push(`${this.marker}:${directory}:${String(options.noFollow)}`);
        expect(Object.isFrozen(options)).toBe(true);
        return directoryResult;
      },
    };
    const rawMutation = {
      marker: "mutation",
      async acquireSetupLease(
        this: { marker: string },
        directory: string,
        options: {
          readonly noFollow: true;
          readonly createDirectory: true;
          readonly nonce: CredentialSetupLeaseNonce;
        },
      ) {
        calls.push(
          `${this.marker}:${directory}:${String(options.noFollow)}:${String(
            options.createDirectory,
          )}:${options.nonce}`,
        );
        expect(Object.isFrozen(options)).toBe(true);
        return leaseResult;
      },
    };
    const provider = createNativeCredentialStoreProvider(
      TARGET,
      resolverReturning(
        createNativeModule({
          createAdapters() {
            return { read: rawRead, mutation: rawMutation };
          },
        }),
      ),
    );
    const loaded = provider.load();

    expect(loaded.status).toBe("available");
    if (loaded.status !== "available") {
      throw new Error("native credential provider unexpectedly unavailable");
    }

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.read)).toBe(true);
    expect(Object.isFrozen(loaded.mutation)).toBe(true);
    expect(Object.keys(loaded.read)).toEqual(["openPrivateDirectory"]);
    expect(Object.keys(loaded.mutation)).toEqual(["acquireSetupLease"]);

    await expect(
      loaded.read.openPrivateDirectory("/isolated/plurum", {
        noFollow: true,
      }),
    ).resolves.toBe(directoryResult);
    await expect(
      loaded.mutation.acquireSetupLease("/isolated/plurum", {
        noFollow: true,
        createDirectory: true,
        nonce:
          "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce,
      }),
    ).resolves.toBe(leaseResult);
    expect(calls).toEqual([
      "read:/isolated/plurum:true",
      "mutation:/isolated/plurum:true:true:018f5d10-ee3a-476f-9bfb-c1e93dd50074",
    ]);
  });

  it.each([
    ["missing module", undefined],
    ["null module", null],
    ["primitive module", SECRET_SENTINEL],
    [
      "wrong magic",
      createNativeModule({ magic: `wrong-${SECRET_SENTINEL}` }),
    ],
    [
      "wrong ABI",
      createNativeModule({ abiVersion: NATIVE_CREDENTIAL_STORE_ABI_VERSION + 1 }),
    ],
    [
      "wrong Node-API version",
      createNativeModule({
        nodeApiVersion: NATIVE_CREDENTIAL_STORE_NODE_API_VERSION + 1,
      }),
    ],
    [
      "wrong package version",
      createNativeModule({ packageVersion: "999.0.0" }),
    ],
    [
      "wrong target",
      createNativeModule({ target: "darwin-x64" }),
    ],
    [
      "missing factory",
      {
        magic: NATIVE_CREDENTIAL_STORE_MAGIC,
        abiVersion: NATIVE_CREDENTIAL_STORE_ABI_VERSION,
        nodeApiVersion: NATIVE_CREDENTIAL_STORE_NODE_API_VERSION,
        packageVersion: CLI_VERSION,
        target: TARGET,
      },
    ],
    [
      "extra descriptor key",
      createNativeModule({ unexpected: SECRET_SENTINEL }),
    ],
    [
      "malformed adapter pair",
      createNativeModule({
        createAdapters() {
          return { read: {}, mutation: {} };
        },
      }),
    ],
    [
      "extra adapter-pair key",
      createNativeModule({
        createAdapters() {
          return {
            read: {
              async openPrivateDirectory() {
                return { status: "missing" as const };
              },
            },
            mutation: {
              async acquireSetupLease() {
                return { status: "busy" as const };
              },
            },
            unexpected: SECRET_SENTINEL,
          };
        },
      }),
    ],
  ])("fails closed for a %s without reflecting module data", (_label, module) => {
    const result = createNativeCredentialStoreProvider(
      TARGET,
      resolverReturning(module),
    ).load();

    expect(result).toEqual({
      status: "unavailable",
      code: "native_credential_store_unavailable",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it("catches and memoizes resolver and factory failures without exposing causes", () => {
    for (const failurePoint of ["resolver", "factory"] as const) {
      let resolveCalls = 0;
      let factoryCalls = 0;
      const provider = createNativeCredentialStoreProvider(
        TARGET,
        () => {
          resolveCalls += 1;
          if (failurePoint === "resolver") {
            throw new Error(SECRET_SENTINEL);
          }
          return createNativeModule({
            createAdapters() {
              factoryCalls += 1;
              throw new Error(SECRET_SENTINEL);
            },
          });
        },
      );

      const first = provider.load();
      expect(provider.load()).toBe(first);
      expect(first).toEqual({
        status: "unavailable",
        code: "native_credential_store_unavailable",
      });
      expect(JSON.stringify(first)).not.toContain(SECRET_SENTINEL);
      expect(resolveCalls).toBe(1);
      expect(factoryCalls).toBe(failurePoint === "factory" ? 1 : 0);
    }
  });

  it("consumes rejected Promise results before failing closed", async () => {
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
      for (const failurePoint of ["resolver", "factory"] as const) {
        const provider = createNativeCredentialStoreProvider(TARGET, () => {
          if (failurePoint === "resolver") {
            return Promise.reject(new Error(SECRET_SENTINEL));
          }
          return createNativeModule({
            createAdapters() {
              return Promise.reject(new Error(SECRET_SENTINEL));
            },
          });
        });

        const first = provider.load();
        expect(provider.load()).toBe(first);
        expect(first).toEqual({
          status: "unavailable",
          code: "native_credential_store_unavailable",
        });
        expect(JSON.stringify(first)).not.toContain(SECRET_SENTINEL);
      }

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandledRejection);
    }
  });

  it("catches throwing descriptor getters without reflecting their causes", () => {
    const module = createNativeModule();
    Object.defineProperty(module, "magic", {
      enumerable: true,
      get() {
        throw new Error(SECRET_SENTINEL);
      },
    });
    const result = createNativeCredentialStoreProvider(
      TARGET,
      resolverReturning(module),
    ).load();

    expect(result).toEqual({
      status: "unavailable",
      code: "native_credential_store_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it("captures descriptor, pair, and method getters exactly once", async () => {
    let factoryReads = 0;
    let pairReadReads = 0;
    let methodReads = 0;
    const read = Object.defineProperty({}, "openPrivateDirectory", {
      enumerable: true,
      get() {
        methodReads += 1;
        if (methodReads > 1) {
          return async () => {
            throw new Error(SECRET_SENTINEL);
          };
        }
        return async () => ({ status: "missing" as const });
      },
    });
    const mutation = {
      async acquireSetupLease() {
        return { status: "busy" as const };
      },
    };
    const pair = Object.defineProperties(
      { mutation },
      {
        read: {
          enumerable: true,
          get() {
            pairReadReads += 1;
            return pairReadReads === 1
              ? read
              : {
                  async openPrivateDirectory() {
                    throw new Error(SECRET_SENTINEL);
                  },
                };
          },
        },
      },
    );
    const module = createNativeModule();
    Object.defineProperty(module, "createAdapters", {
      enumerable: true,
      get() {
        factoryReads += 1;
        return factoryReads === 1
          ? function createAdapters() {
              return pair;
            }
          : function unvalidatedFactory() {
              throw new Error(SECRET_SENTINEL);
            };
      },
    });

    const loaded = createNativeCredentialStoreProvider(
      TARGET,
      resolverReturning(module),
    ).load();

    expect(loaded.status).toBe("available");
    if (loaded.status !== "available") {
      throw new Error("native credential provider unexpectedly unavailable");
    }
    await expect(
      loaded.read.openPrivateDirectory("/isolated/plurum", {
        noFollow: true,
      }),
    ).resolves.toEqual({ status: "missing" });
    expect(factoryReads).toBe(1);
    expect(pairReadReads).toBe(1);
    expect(methodReads).toBe(1);
  });

  it("never consults poisoned own call properties on captured functions", async () => {
    let factoryInvocations = 0;
    let readInvocations = 0;
    let mutationInvocations = 0;
    let factoryCallReads = 0;
    let readCallReads = 0;
    let mutationCallReads = 0;
    let moduleValue: Record<string, unknown>;
    let readReceiver: Record<string, unknown>;
    let mutationReceiver: Record<string, unknown>;

    const openPrivateDirectory: CredentialStoreReadAdapter["openPrivateDirectory"] =
      async function (
        this: unknown,
        _directory: string,
        _options: { readonly noFollow: true },
      ) {
        readInvocations += 1;
        expect(this).toBe(readReceiver);
        return { status: "missing" as const };
      };
    Object.defineProperty(openPrivateDirectory, "call", {
      configurable: true,
      get() {
        readCallReads += 1;
        throw new Error(SECRET_SENTINEL);
      },
    });
    readReceiver = { openPrivateDirectory };

    const acquireSetupLease: CredentialStoreMutationAdapter["acquireSetupLease"] =
      async function (
        this: unknown,
        _directory: string,
        _options: Readonly<{
          noFollow: true;
          createDirectory: true;
          nonce: CredentialSetupLeaseNonce;
        }>,
      ) {
        mutationInvocations += 1;
        expect(this).toBe(mutationReceiver);
        return { status: "busy" as const };
      };
    Object.defineProperty(acquireSetupLease, "call", {
      configurable: true,
      get() {
        mutationCallReads += 1;
        throw new Error(SECRET_SENTINEL);
      },
    });
    mutationReceiver = { acquireSetupLease };

    const createAdapters = function (this: unknown): unknown {
      factoryInvocations += 1;
      expect(this).toBe(moduleValue);
      return { read: readReceiver, mutation: mutationReceiver };
    };
    Object.defineProperty(createAdapters, "call", {
      configurable: true,
      get() {
        factoryCallReads += 1;
        throw new Error(SECRET_SENTINEL);
      },
    });
    moduleValue = createNativeModule({ createAdapters });

    const loaded = createNativeCredentialStoreProvider(
      TARGET,
      resolverReturning(moduleValue),
    ).load();

    expect(loaded.status).toBe("available");
    if (loaded.status !== "available") {
      throw new Error("native credential provider unexpectedly unavailable");
    }
    await expect(
      loaded.read.openPrivateDirectory("/isolated/plurum", {
        noFollow: true,
      }),
    ).resolves.toEqual({ status: "missing" });
    await expect(
      loaded.mutation.acquireSetupLease("/isolated/plurum", {
        noFollow: true,
        createDirectory: true,
        nonce:
          "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce,
      }),
    ).resolves.toEqual({ status: "busy" });
    expect({
      factoryInvocations,
      readInvocations,
      mutationInvocations,
      factoryCallReads,
      readCallReads,
      mutationCallReads,
    }).toEqual({
      factoryInvocations: 1,
      readInvocations: 1,
      mutationInvocations: 1,
      factoryCallReads: 0,
      readCallReads: 0,
      mutationCallReads: 0,
    });
  });

  it("rejects a noncanonical lease nonce before native delegation", async () => {
    let mutationCalls = 0;
    const loaded = createNativeCredentialStoreProvider(
      TARGET,
      resolverReturning(
        createNativeModule({
          createAdapters() {
            return {
              read: {
                async openPrivateDirectory() {
                  return { status: "missing" as const };
                },
              },
              mutation: {
                async acquireSetupLease() {
                  mutationCalls += 1;
                  return { status: "busy" as const };
                },
              },
            };
          },
        }),
      ),
    ).load();

    expect(loaded.status).toBe("available");
    if (loaded.status !== "available") {
      throw new Error("native credential provider unexpectedly unavailable");
    }
    await expect(
      loaded.mutation.acquireSetupLease("/isolated/plurum", {
        noFollow: true,
        createDirectory: true,
        nonce: "NOT-A-LOWERCASE-UUID-V4" as CredentialSetupLeaseNonce,
      }),
    ).rejects.toThrow("The native credential adapter request is invalid.");
    expect(mutationCalls).toBe(0);
  });

  it("delegates only the single validated nonce snapshot", async () => {
    const validNonce =
      "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce;
    let nonceReads = 0;
    let delegatedNonce: CredentialSetupLeaseNonce | undefined;
    const loaded = createNativeCredentialStoreProvider(
      TARGET,
      resolverReturning(
        createNativeModule({
          createAdapters() {
            return {
              read: {
                async openPrivateDirectory() {
                  return { status: "missing" as const };
                },
              },
              mutation: {
                async acquireSetupLease(
                  _directory: string,
                  options: {
                    readonly nonce: CredentialSetupLeaseNonce;
                  },
                ) {
                  delegatedNonce = options.nonce;
                  return { status: "busy" as const };
                },
              },
            };
          },
        }),
      ),
    ).load();
    const options = Object.defineProperties(
      {},
      {
        noFollow: { enumerable: true, value: true },
        createDirectory: { enumerable: true, value: true },
        nonce: {
          enumerable: true,
          get() {
            nonceReads += 1;
            return nonceReads === 1 ? validNonce : SECRET_SENTINEL;
          },
        },
      },
    ) as Readonly<{
      noFollow: true;
      createDirectory: true;
      nonce: CredentialSetupLeaseNonce;
    }>;

    expect(loaded.status).toBe("available");
    if (loaded.status !== "available") {
      throw new Error("native credential provider unexpectedly unavailable");
    }
    await expect(
      loaded.mutation.acquireSetupLease("/isolated/plurum", options),
    ).resolves.toEqual({ status: "busy" });
    expect(nonceReads).toBe(1);
    expect(delegatedNonce).toBe(validNonce);
  });

  it("fails closed and memoizes a reentrant resolver load", () => {
    let provider: NativeCredentialStoreProvider | undefined;
    let nestedLoadResult: unknown;
    let resolveCalls = 0;
    let factoryCalls = 0;
    const resolver: NativeCredentialModuleResolver = () => {
      resolveCalls += 1;
      nestedLoadResult = provider?.load();
      return createNativeModule({
        createAdapters() {
          factoryCalls += 1;
          return {};
        },
      });
    };
    provider = createNativeCredentialStoreProvider(TARGET, resolver);

    const first = provider.load();

    expect(first).toEqual({
      status: "unavailable",
      code: "native_credential_store_unavailable",
    });
    expect(provider.load()).toBe(first);
    expect(nestedLoadResult).toEqual({
      status: "unavailable",
      code: "native_credential_store_unavailable",
    });
    expect(resolveCalls).toBe(1);
    expect(factoryCalls).toBe(0);
  });

  it("does not invoke the factory after descriptor inspection reenters load", () => {
    let provider: NativeCredentialStoreProvider | undefined;
    let nestedLoadResult: unknown;
    let factoryCalls = 0;
    const moduleValue = createNativeModule({
      createAdapters() {
        factoryCalls += 1;
        return {};
      },
    });
    Object.defineProperty(moduleValue, "magic", {
      enumerable: true,
      get() {
        nestedLoadResult = provider?.load();
        return NATIVE_CREDENTIAL_STORE_MAGIC;
      },
    });
    provider = createNativeCredentialStoreProvider(
      TARGET,
      resolverReturning(moduleValue),
    );

    const first = provider.load();

    expect(first).toEqual({
      status: "unavailable",
      code: "native_credential_store_unavailable",
    });
    expect(provider.load()).toBe(first);
    expect(nestedLoadResult).toEqual({
      status: "unavailable",
      code: "native_credential_store_unavailable",
    });
    expect(factoryCalls).toBe(0);
  });

  it("rejects an unsupported target before invoking the resolver", () => {
    let resolveCalls = 0;
    const provider = createNativeCredentialStoreProvider(
      "freebsd-x64" as NativeCredentialTarget,
      () => {
        resolveCalls += 1;
        return createNativeModule();
      },
    );

    expect(provider.load()).toEqual({
      status: "unavailable",
      code: "native_credential_store_unavailable",
    });
    expect(resolveCalls).toBe(0);
  });
});
