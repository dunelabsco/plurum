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
  CredentialSetupLeaseNonce,
  CredentialTemporaryEntry,
} from "../src/credentials/store-mutation-contracts.js";

const TARGET = "darwin-arm64" satisfies NativeCredentialTarget;
const SECRET_SENTINEL = "plrm_live_NATIVE_PROVIDER_SECRET_SENTINEL";

function createNativeModule(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const read = Object.freeze({
    openPrivateDirectory() {
      return { status: "missing" as const };
    },
  });
  const mutation = Object.freeze({
    acquireSetupLease() {
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

function rawDirectoryAttestation(): Record<string, unknown> {
  return {
    kind: "directory",
    identity: {
      volume: "posix-device-0000000000000001",
      object: "posix-inode-0000000000000002",
    },
    revision: "directory-revision",
    binding: "canonical-current",
    owner: "current-user",
    access: "user-only",
    link: "direct",
  };
}

function rawFileAttestation(size: number): Record<string, unknown> {
  return {
    kind: "regular-file",
    identity: {
      volume: "posix-device-0000000000000001",
      object: "posix-inode-0000000000000003",
    },
    parentIdentity: {
      volume: "posix-device-0000000000000001",
      object: "posix-inode-0000000000000002",
    },
    revision: "file-revision",
    binding: "canonical-current",
    owner: "current-user",
    access: "user-only",
    link: "direct",
    links: 1,
    size,
  };
}

function loadAvailable(moduleValue: unknown) {
  const loaded = createNativeCredentialStoreProvider(
    TARGET,
    resolverReturning(moduleValue),
  ).load();
  expect(loaded.status).toBe("available");
  if (loaded.status !== "available") {
    throw new Error("native credential provider unexpectedly unavailable");
  }
  return loaded;
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
            openPrivateDirectory() {
              return { status: "missing" as const };
            },
          },
          mutation: {
            acquireSetupLease() {
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
    let rawRead: Record<string, unknown>;
    rawRead = {
      openPrivateDirectory(
        this: unknown,
        directory: string,
        options: { readonly noFollow: true },
      ) {
        expect(this).toBe(rawRead);
        calls.push(`read:${directory}:${String(options.noFollow)}`);
        expect(Object.isFrozen(options)).toBe(true);
        return { status: "missing" as const };
      },
    };
    let rawMutation: Record<string, unknown>;
    rawMutation = {
      acquireSetupLease(
        this: unknown,
        directory: string,
        options: {
          readonly noFollow: true;
          readonly createDirectory: true;
          readonly nonce: CredentialSetupLeaseNonce;
        },
      ) {
        expect(this).toBe(rawMutation);
        calls.push(
          `mutation:${directory}:${String(options.noFollow)}:${String(
            options.createDirectory,
          )}:${options.nonce}`,
        );
        expect(Object.isFrozen(options)).toBe(true);
        return { status: "busy" as const };
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
    ).resolves.toEqual({ status: "missing" });
    await expect(
      loaded.mutation.acquireSetupLease("/isolated/plurum", {
        noFollow: true,
        createDirectory: true,
        nonce:
          "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce,
      }),
    ).resolves.toEqual({ status: "busy" });
    expect(calls).toEqual([
      "read:/isolated/plurum:true",
      "mutation:/isolated/plurum:true:true:018f5d10-ee3a-476f-9bfb-c1e93dd50074",
    ]);
  });

  it("does not inspect inherited handle fields on terminal result branches", async () => {
    let inheritedHandleReads = 0;
    const missing = Object.create({
      get directory() {
        inheritedHandleReads += 1;
        return {};
      },
    }) as Record<string, unknown>;
    missing.status = "missing";
    const busy = Object.create({
      get lease() {
        inheritedHandleReads += 1;
        return {};
      },
    }) as Record<string, unknown>;
    busy.status = "busy";
    const loaded = loadAvailable(
      createNativeModule({
        createAdapters() {
          return {
            read: {
              openPrivateDirectory() {
                return missing;
              },
            },
            mutation: {
              acquireSetupLease() {
                return busy;
              },
            },
          };
        },
      }),
    );

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
    expect(inheritedHandleReads).toBe(0);
  });

  it("deeply membranes read handles and wipes both native and public secret buffers", async () => {
    const rawBytes = new Uint8Array([11, 22, 33]);
    let rawOpenCalls = 0;
    let attestGetterReads = 0;
    const rawFile = {
      attest() {
        return rawFileAttestation(3);
      },
      readBounded(options: { readonly maxBytes: number }) {
        expect(Object.isFrozen(options)).toBe(true);
        expect(options).toEqual({ maxBytes: 3 });
        return {
          bytes: rawBytes,
          endOfFile: true,
        };
      },
      close() {},
    };
    const rawDirectory = Object.defineProperties(
      {
        openCredentialReadOnly(options: {
          readonly entry: string;
          readonly noFollow: boolean;
        }) {
          expect(Object.isFrozen(options)).toBe(true);
          expect(options).toEqual({
            entry: "credentials.json",
            noFollow: true,
          });
          return { status: "opened", file: rawFile };
        },
        close() {},
      },
      {
        attest: {
          enumerable: true,
          get() {
            attestGetterReads += 1;
            return attestGetterReads === 1
              ? () => rawDirectoryAttestation()
              : () => {
                  throw new Error(SECRET_SENTINEL);
                };
          },
        },
      },
    );
    const loaded = loadAvailable(
      createNativeModule({
        createAdapters() {
          return {
            read: {
              openPrivateDirectory() {
                rawOpenCalls += 1;
                return { status: "opened", directory: rawDirectory };
              },
            },
            mutation: {
              acquireSetupLease() {
                return { status: "busy" };
              },
            },
          };
        },
      }),
    );

    const directoryPromise = loaded.read.openPrivateDirectory(
      "/isolated/plurum",
      { noFollow: true },
    );
    expect(rawOpenCalls).toBe(1);
    const openedDirectory = await directoryPromise;
    expect(openedDirectory.status).toBe("opened");
    if (openedDirectory.status !== "opened") {
      throw new Error("raw directory fixture unexpectedly missing");
    }
    expect(Object.isFrozen(openedDirectory)).toBe(true);
    expect(Object.isFrozen(openedDirectory.directory)).toBe(true);
    expect(Object.keys(openedDirectory.directory).sort()).toEqual([
      "attest",
      "close",
      "openCredentialReadOnly",
    ]);

    const directoryAttestation = await openedDirectory.directory.attest();
    expect(attestGetterReads).toBe(1);
    expect(Object.isFrozen(directoryAttestation)).toBe(true);
    expect(Object.isFrozen(directoryAttestation.identity)).toBe(true);
    expect(Object.keys(directoryAttestation).sort()).toEqual([
      "access",
      "binding",
      "identity",
      "kind",
      "link",
      "owner",
      "revision",
    ]);

    const openedFile = await openedDirectory.directory.openCredentialReadOnly({
      entry: "credentials.json",
      noFollow: true,
    });
    expect(openedFile.status).toBe("opened");
    if (openedFile.status !== "opened") {
      throw new Error("raw file fixture unexpectedly missing");
    }
    expect(Object.isFrozen(openedFile.file)).toBe(true);

    const boundedPromise = openedFile.file.readBounded({ maxBytes: 3 });
    expect([...rawBytes]).toEqual([0, 0, 0]);
    const bounded = await boundedPromise;
    expect(Object.isFrozen(bounded)).toBe(true);
    expect([...bounded.bytes]).toEqual([11, 22, 33]);
    expect(bounded.bytes).not.toBe(rawBytes);

    const closePromise = openedFile.file.close();
    expect([...bounded.bytes]).toEqual([0, 0, 0]);
    await closePromise;
    await openedDirectory.directory.close();
  });

  it("keeps snapshots opaque and lease-scoped while copying and wiping write bytes", async () => {
    const transactionId = "018f5d10-ee3a-476f-9bfb-c1e93dd50074";
    let hostileArrayMapCalls = 0;
    let hostileArraySpeciesCalls = 0;
    const entry = Object.freeze({
      kind: "temporary",
      role: "credential-candidate",
      transactionId,
    }) as CredentialTemporaryEntry;
    const rawLeases = [0, 1].map((index) => {
      const rawSnapshot = Object.freeze({});
      let createCalls = 0;
      let delegatedSnapshot: unknown;
      let delegatedWriteBytes: Uint8Array | undefined;
      let writeBytesDuringCall: Uint8Array | undefined;
      const rawWrite = {
        attest() {
          return rawFileAttestation(2);
        },
        writeAll(bytes: Uint8Array) {
          delegatedWriteBytes = bytes;
          writeBytesDuringCall = bytes.slice();
        },
        sync() {},
        close() {},
      };
      const lease = {
        abandon() {},
        attestDirectory() {
          return rawDirectoryAttestation();
        },
        createTemporaryExclusive(options: {
          readonly entry: CredentialTemporaryEntry;
          readonly expected: unknown;
        }) {
          createCalls += 1;
          delegatedSnapshot = options.expected;
          expect(Object.isFrozen(options)).toBe(true);
          expect(Object.isFrozen(options.entry)).toBe(true);
          return { status: "created", file: rawWrite };
        },
        listTemporaryEntries() {
          const entries: CredentialTemporaryEntry[] = [];
          Object.defineProperty(entries, "map", {
            value() {
              hostileArrayMapCalls += 1;
              throw new Error(SECRET_SENTINEL);
            },
          });
          Object.defineProperty(entries, "constructor", {
            value: {
              get [Symbol.species]() {
                hostileArraySpeciesCalls += 1;
                return Array;
              },
            },
          });
          return entries;
        },
        moveTemporaryConditionally() {
          return { status: "conflict" };
        },
        observeEntry(observedEntry: CredentialTemporaryEntry) {
          expect(Object.isFrozen(observedEntry)).toBe(true);
          expect(observedEntry).toEqual(entry);
          return { status: "missing", snapshot: rawSnapshot };
        },
        release() {},
        removeConditionally() {
          return { status: "conflict" };
        },
        renew() {
          return { status: "held" };
        },
        syncDirectory() {},
      };
      return {
        index,
        lease,
        rawSnapshot,
        get createCalls() {
          return createCalls;
        },
        get delegatedSnapshot() {
          return delegatedSnapshot;
        },
        get delegatedWriteBytes() {
          return delegatedWriteBytes;
        },
        get writeBytesDuringCall() {
          return writeBytesDuringCall;
        },
      };
    });
    let acquireCalls = 0;
    const loaded = loadAvailable(
      createNativeModule({
        createAdapters() {
          return {
            read: {
              openPrivateDirectory() {
                return { status: "missing" };
              },
            },
            mutation: {
              acquireSetupLease() {
                const fixture = rawLeases[acquireCalls];
                acquireCalls += 1;
                if (fixture === undefined) {
                  throw new Error(SECRET_SENTINEL);
                }
                return {
                  status: "acquired",
                  priorLease: "absent",
                  directory: "existing",
                  lease: fixture.lease,
                };
              },
            },
          };
        },
      }),
    );
    const nonceA =
      "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce;
    const nonceB =
      "028f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce;
    const acquiredA = await loaded.mutation.acquireSetupLease(
      "/isolated/plurum",
      { noFollow: true, createDirectory: true, nonce: nonceA },
    );
    const acquiredB = await loaded.mutation.acquireSetupLease(
      "/isolated/plurum",
      { noFollow: true, createDirectory: true, nonce: nonceB },
    );
    expect(acquiredA.status).toBe("acquired");
    expect(acquiredB.status).toBe("acquired");
    if (acquiredA.status !== "acquired" || acquiredB.status !== "acquired") {
      throw new Error("raw lease fixture unexpectedly busy");
    }
    expect(Object.isFrozen(acquiredA.lease)).toBe(true);
    expect(Object.keys(acquiredA.lease).sort()).toEqual([
      "abandon",
      "attestDirectory",
      "createTemporaryExclusive",
      "listTemporaryEntries",
      "moveTemporaryConditionally",
      "observeEntry",
      "release",
      "removeConditionally",
      "renew",
      "syncDirectory",
    ]);

    const observedA = await acquiredA.lease.observeEntry(entry);
    const observedB = await acquiredB.lease.observeEntry(entry);
    expect(observedA.status).toBe("missing");
    expect(observedB.status).toBe("missing");
    if (observedA.status !== "missing" || observedB.status !== "missing") {
      throw new Error("raw snapshot fixture unexpectedly opened");
    }
    expect(Object.isFrozen(observedA.snapshot)).toBe(true);
    expect(Object.keys(observedA.snapshot)).toEqual([]);
    expect(observedA.snapshot).not.toBe(rawLeases[0]?.rawSnapshot);
    const temporaryEntries = await acquiredA.lease.listTemporaryEntries();
    expect(temporaryEntries).toEqual([]);
    expect(Object.isFrozen(temporaryEntries)).toBe(true);
    expect(hostileArrayMapCalls).toBe(0);
    expect(hostileArraySpeciesCalls).toBe(0);

    const created = await acquiredA.lease.createTemporaryExclusive({
      entry,
      expected: observedA.snapshot,
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      throw new Error("raw write fixture unexpectedly conflicted");
    }
    expect(rawLeases[0]?.delegatedSnapshot).toBe(rawLeases[0]?.rawSnapshot);
    const callerBytes = new Uint8Array([7, 8]);
    const writePromise = created.file.writeAll(callerBytes);
    expect(rawLeases[0]?.writeBytesDuringCall).toEqual(
      new Uint8Array([7, 8]),
    );
    expect(rawLeases[0]?.delegatedWriteBytes).not.toBe(callerBytes);
    expect([...(rawLeases[0]?.delegatedWriteBytes ?? [])]).toEqual([0, 0]);
    expect([...callerBytes]).toEqual([7, 8]);
    await writePromise;
    await created.file.close();

    await expect(
      acquiredB.lease.createTemporaryExclusive({
        entry,
        expected: observedA.snapshot,
      }),
    ).rejects.toThrow("The native credential adapter request is invalid.");
    await expect(
      acquiredB.lease.createTemporaryExclusive({
        entry,
        expected: Object.freeze({}) as typeof observedB.snapshot,
      }),
    ).rejects.toThrow("The native credential adapter request is invalid.");
    expect(rawLeases[1]?.createCalls).toBe(0);

    await acquiredA.lease.release();
    await acquiredB.lease.release();
  });

  it("uses bounded base typed-array copies without consulting caller species", async () => {
    const transactionId = "018f5d10-ee3a-476f-9bfb-c1e93dd50074";
    const entry = Object.freeze({
      kind: "temporary",
      role: "credential-candidate",
      transactionId,
    }) as CredentialTemporaryEntry;
    const rawSnapshot = Object.freeze({});
    let rawWriteCalls = 0;
    let rawCloseCalls = 0;
    let unexpectedSpeciesAllocations = 0;
    let delegatedWriteBytes: Uint8Array | undefined;
    const rawWrite = {
      attest() {
        return rawFileAttestation(3);
      },
      writeAll(bytes: Uint8Array) {
        rawWriteCalls += 1;
        delegatedWriteBytes = bytes;
      },
      sync() {},
      close() {
        rawCloseCalls += 1;
      },
    };
    const rawLease = {
      abandon() {},
      attestDirectory() {
        return rawDirectoryAttestation();
      },
      createTemporaryExclusive() {
        return { status: "created", file: rawWrite };
      },
      listTemporaryEntries() {
        return [];
      },
      moveTemporaryConditionally() {
        return { status: "conflict" };
      },
      observeEntry() {
        return { status: "missing", snapshot: rawSnapshot };
      },
      release() {},
      removeConditionally() {
        return { status: "conflict" };
      },
      renew() {
        return { status: "held" };
      },
      syncDirectory() {},
    };
    const loaded = loadAvailable(
      createNativeModule({
        createAdapters() {
          return {
            read: {
              openPrivateDirectory() {
                return { status: "missing" };
              },
            },
            mutation: {
              acquireSetupLease() {
                return {
                  status: "acquired",
                  priorLease: "absent",
                  directory: "existing",
                  lease: rawLease,
                };
              },
            },
          };
        },
      }),
    );
    const acquired = await loaded.mutation.acquireSetupLease(
      "/isolated/plurum",
      {
        noFollow: true,
        createDirectory: true,
        nonce:
          "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce,
      },
    );
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      throw new Error("raw lease fixture unexpectedly busy");
    }
    const lease = acquired.lease;
    const observed = await lease.observeEntry(entry);
    expect(observed.status).toBe("missing");
    if (observed.status !== "missing") {
      throw new Error("raw snapshot fixture unexpectedly opened");
    }
    const created = await lease.createTemporaryExclusive({
      entry,
      expected: observed.snapshot,
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") {
      throw new Error("raw write fixture unexpectedly conflicted");
    }

    class UnexpectedArray extends Uint8Array {
      constructor(length: number) {
        super(length);
        unexpectedSpeciesAllocations += 1;
      }
    }
    const oversizedBytes = new Uint8Array(40_961);
    Object.defineProperty(oversizedBytes, "constructor", {
      value: { [Symbol.species]: UnexpectedArray },
    });
    Object.defineProperty(oversizedBytes, "byteLength", {
      value: 1,
    });
    await expect(created.file.writeAll(oversizedBytes)).rejects.toThrow(
      "The native credential adapter request is invalid.",
    );
    expect(unexpectedSpeciesAllocations).toBe(0);
    expect(rawWriteCalls).toBe(0);

    await created.file.close();
    const bytesAfterClose = new Uint8Array([6]);
    Object.defineProperty(bytesAfterClose, "constructor", {
      value: { [Symbol.species]: UnexpectedArray },
    });
    await expect(created.file.writeAll(bytesAfterClose)).rejects.toThrow(
      "The native credential operation failed.",
    );
    expect(unexpectedSpeciesAllocations).toBe(0);
    expect(rawCloseCalls).toBe(1);

    const speciesSafeCreated = await lease.createTemporaryExclusive({
      entry,
      expected: observed.snapshot,
    });
    expect(speciesSafeCreated.status).toBe("created");
    if (speciesSafeCreated.status !== "created") {
      throw new Error("raw write fixture unexpectedly conflicted");
    }
    const callerBytes = new Uint8Array([9, 8, 7]);
    Object.defineProperty(callerBytes, "constructor", {
      value: { [Symbol.species]: UnexpectedArray },
    });

    await expect(speciesSafeCreated.file.writeAll(callerBytes)).resolves.toBe(
      undefined,
    );
    expect(rawWriteCalls).toBe(1);
    expect(unexpectedSpeciesAllocations).toBe(0);
    expect(delegatedWriteBytes).not.toBe(callerBytes);
    expect([...(delegatedWriteBytes ?? [])]).toEqual([0, 0, 0]);
    expect([...callerBytes]).toEqual([9, 8, 7]);
    await speciesSafeCreated.file.close();
    await lease.release();
    expect(rawCloseCalls).toBe(2);
  });

  it("captures result fields once and makes a reentrant lease terminal exactly once", async () => {
    let renewStatusReads = 0;
    let rawReleaseCalls = 0;
    let invokePublicRelease: (() => Promise<void>) | undefined;
    let nestedRelease: Promise<void> | undefined;
    let nestedFailure = "";
    const rawLease = {
      abandon() {},
      attestDirectory() {
        return rawDirectoryAttestation();
      },
      createTemporaryExclusive() {
        return { status: "conflict" };
      },
      listTemporaryEntries() {
        return [];
      },
      moveTemporaryConditionally() {
        return { status: "conflict" };
      },
      observeEntry() {
        return { status: "missing", snapshot: Object.freeze({}) };
      },
      release() {
        rawReleaseCalls += 1;
        nestedRelease = invokePublicRelease?.().catch((error: unknown) => {
          nestedFailure = String(error);
        });
      },
      removeConditionally() {
        return { status: "conflict" };
      },
      renew() {
        const result: Record<string, unknown> = {};
        Object.defineProperty(result, "status", {
          enumerable: true,
          get() {
            renewStatusReads += 1;
            return renewStatusReads === 1 ? "held" : SECRET_SENTINEL;
          },
        });
        return result;
      },
      syncDirectory() {},
    };
    const loaded = loadAvailable(
      createNativeModule({
        createAdapters() {
          return {
            read: {
              openPrivateDirectory() {
                return { status: "missing" };
              },
            },
            mutation: {
              acquireSetupLease() {
                return {
                  status: "acquired",
                  priorLease: "absent",
                  directory: "existing",
                  lease: rawLease,
                };
              },
            },
          };
        },
      }),
    );
    const acquired = await loaded.mutation.acquireSetupLease(
      "/isolated/plurum",
      {
        noFollow: true,
        createDirectory: true,
        nonce:
          "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce,
      },
    );
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      throw new Error("raw lease fixture unexpectedly busy");
    }
    const lease = acquired.lease;
    invokePublicRelease = () => lease.release();

    await expect(lease.renew()).resolves.toEqual({ status: "held" });
    expect(renewStatusReads).toBe(1);
    await invokePublicRelease();
    await nestedRelease;
    expect(rawReleaseCalls).toBe(1);
    expect(nestedFailure).toContain("The native credential operation failed.");
    expect(nestedFailure).not.toContain(SECRET_SENTINEL);
  });

  it("rejects and closes a child whose method capture ends its parent lease", async () => {
    let rawReleaseCalls = 0;
    let rawCloseCalls = 0;
    let invokePublicRelease: (() => Promise<void>) | undefined;
    let releasePromise: Promise<void> | undefined;
    const rawFile: Record<string, unknown> = {};
    Object.defineProperties(rawFile, {
      attest: {
        enumerable: true,
        get() {
          releasePromise = invokePublicRelease?.();
          return () => rawFileAttestation(0);
        },
      },
      close: {
        enumerable: true,
        value() {
          rawCloseCalls += 1;
        },
      },
      readBounded: {
        enumerable: true,
        value() {
          return { bytes: new Uint8Array(), endOfFile: true };
        },
      },
    });
    const rawLease = {
      abandon() {},
      attestDirectory() {
        return rawDirectoryAttestation();
      },
      createTemporaryExclusive() {
        return { status: "conflict" };
      },
      listTemporaryEntries() {
        return [];
      },
      moveTemporaryConditionally() {
        return { status: "conflict" };
      },
      observeEntry() {
        return {
          status: "opened",
          snapshot: Object.freeze({}),
          attestation: rawFileAttestation(0),
          file: rawFile,
        };
      },
      release() {
        rawReleaseCalls += 1;
      },
      removeConditionally() {
        return { status: "conflict" };
      },
      renew() {
        return { status: "held" };
      },
      syncDirectory() {},
    };
    const loaded = loadAvailable(
      createNativeModule({
        createAdapters() {
          return {
            read: {
              openPrivateDirectory() {
                return { status: "missing" };
              },
            },
            mutation: {
              acquireSetupLease() {
                return {
                  status: "acquired",
                  priorLease: "absent",
                  directory: "existing",
                  lease: rawLease,
                };
              },
            },
          };
        },
      }),
    );
    const acquired = await loaded.mutation.acquireSetupLease(
      "/isolated/plurum",
      {
        noFollow: true,
        createDirectory: true,
        nonce:
          "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce,
      },
    );
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      throw new Error("raw lease fixture unexpectedly busy");
    }
    const lease = acquired.lease;
    invokePublicRelease = () => lease.release();

    await expect(
      lease.observeEntry(
        Object.freeze({
          kind: "canonical",
          role: "credential",
          name: "credentials.json",
        }),
      ),
    ).rejects.toThrow("The native credential operation failed.");
    await releasePromise;
    expect(rawReleaseCalls).toBe(1);
    expect(rawCloseCalls).toBe(1);
    await expect(lease.renew()).rejects.toThrow(
      "The native credential operation failed.",
    );
  });

  it("consumes nested native Promise failures and exposes only a static operation error", async () => {
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
      let attestCalls = 0;
      let customThenCalls = 0;
      const rawDirectory = {
        attest() {
          attestCalls += 1;
          if (attestCalls === 1) {
            const rejected = Promise.reject(new Error(SECRET_SENTINEL));
            Object.defineProperty(rejected, "then", {
              get() {
                throw new Error(SECRET_SENTINEL);
              },
            });
            return rejected;
          }
          if (attestCalls === 2) {
            return {
                then() {
                  customThenCalls += 1;
                  throw new Error(SECRET_SENTINEL);
                },
              };
          }
          return {
            ...rawDirectoryAttestation(),
            identity: Promise.reject(new Error(SECRET_SENTINEL)),
          };
        },
        openCredentialReadOnly() {
          return {
            status: "opened",
            file: Promise.reject(new Error(SECRET_SENTINEL)),
          };
        },
        close() {},
      };
      const loaded = loadAvailable(
        createNativeModule({
          createAdapters() {
            return {
              read: {
                openPrivateDirectory() {
                  return { status: "opened", directory: rawDirectory };
                },
              },
              mutation: {
                acquireSetupLease() {
                  return { status: "busy" };
                },
              },
            };
          },
        }),
      );
      const opened = await loaded.read.openPrivateDirectory(
        "/isolated/plurum",
        { noFollow: true },
      );
      expect(opened.status).toBe("opened");
      if (opened.status !== "opened") {
        throw new Error("raw directory fixture unexpectedly missing");
      }

      const failure = await opened.directory.attest().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("The native credential operation failed.");
      expect(String(failure)).not.toContain(SECRET_SENTINEL);
      const thenableFailure = await opened.directory
        .attest()
        .catch((error: unknown) => error);
      expect(String(thenableFailure)).toContain(
        "The native credential operation failed.",
      );
      expect(String(thenableFailure)).not.toContain(SECRET_SENTINEL);
      expect(customThenCalls).toBe(0);
      const nestedFieldFailure = await opened.directory
        .attest()
        .catch((error: unknown) => error);
      expect(String(nestedFieldFailure)).toContain(
        "The native credential operation failed.",
      );
      expect(String(nestedFieldFailure)).not.toContain(SECRET_SENTINEL);
      const nestedHandleFailure = await opened.directory
        .openCredentialReadOnly({
          entry: "credentials.json",
          noFollow: true,
        })
        .catch((error: unknown) => error);
      expect(String(nestedHandleFailure)).toContain(
        "The native credential operation failed.",
      );
      expect(String(nestedHandleFailure)).not.toContain(SECRET_SENTINEL);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandledRejection);
    }
  });

  it("invalidates lease children and wipes retained read copies before terminal calls return", async () => {
    const rawBytes = new Uint8Array([4, 5]);
    const rawRead = {
      attest() {
        return rawFileAttestation(2);
      },
      readBounded() {
        return { bytes: rawBytes, endOfFile: true };
      },
      close() {},
    };
    const rawLease = {
      abandon() {},
      attestDirectory() {
        return rawDirectoryAttestation();
      },
      createTemporaryExclusive() {
        return { status: "conflict" };
      },
      listTemporaryEntries() {
        return [];
      },
      moveTemporaryConditionally() {
        return { status: "conflict" };
      },
      observeEntry() {
        return {
          status: "opened",
          snapshot: Object.freeze({}),
          attestation: rawFileAttestation(2),
          file: rawRead,
        };
      },
      release() {},
      removeConditionally() {
        return { status: "conflict" };
      },
      renew() {
        return { status: "held" };
      },
      syncDirectory() {},
    };
    const loaded = loadAvailable(
      createNativeModule({
        createAdapters() {
          return {
            read: {
              openPrivateDirectory() {
                return { status: "missing" };
              },
            },
            mutation: {
              acquireSetupLease() {
                return {
                  status: "acquired",
                  priorLease: "absent",
                  directory: "existing",
                  lease: rawLease,
                };
              },
            },
          };
        },
      }),
    );
    const acquired = await loaded.mutation.acquireSetupLease(
      "/isolated/plurum",
      {
        noFollow: true,
        createDirectory: true,
        nonce:
          "018f5d10-ee3a-476f-9bfb-c1e93dd50074" as CredentialSetupLeaseNonce,
      },
    );
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") {
      throw new Error("raw lease fixture unexpectedly busy");
    }
    const observed = await acquired.lease.observeEntry(
      Object.freeze({
        kind: "canonical",
        role: "credential",
        name: "credentials.json",
      }),
    );
    expect(observed.status).toBe("opened");
    if (observed.status !== "opened") {
      throw new Error("raw observation fixture unexpectedly missing");
    }
    const bounded = await observed.file.readBounded({ maxBytes: 2 });
    expect([...bounded.bytes]).toEqual([4, 5]);
    expect([...rawBytes]).toEqual([0, 0]);

    const releasePromise = acquired.lease.release();
    expect([...bounded.bytes]).toEqual([0, 0]);
    await releasePromise;
    await expect(observed.file.attest()).rejects.toThrow(
      "The native credential operation failed.",
    );
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
              openPrivateDirectory() {
                return { status: "missing" as const };
              },
            },
            mutation: {
              acquireSetupLease() {
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

  it.each(["non-enumerable", "symbol"] as const)(
    "rejects a %s descriptor extension",
    (extensionKind) => {
      const module = createNativeModule();
      if (extensionKind === "non-enumerable") {
        Object.defineProperty(module, "unexpected", {
          value: SECRET_SENTINEL,
        });
      } else {
        Object.defineProperty(module, Symbol("unexpected"), {
          value: SECRET_SENTINEL,
        });
      }

      const result = createNativeCredentialStoreProvider(
        TARGET,
        resolverReturning(module),
      ).load();

      expect(result).toEqual({
        status: "unavailable",
        code: "native_credential_store_unavailable",
      });
      expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
    },
  );

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
          return () => {
            throw new Error(SECRET_SENTINEL);
          };
        }
        return () => ({ status: "missing" as const });
      },
    });
    const mutation = {
      acquireSetupLease() {
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
                  openPrivateDirectory() {
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

    const openPrivateDirectory =
      function (
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

    const acquireSetupLease =
      function (
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
                openPrivateDirectory() {
                  return { status: "missing" as const };
                },
              },
              mutation: {
                acquireSetupLease() {
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
                openPrivateDirectory() {
                  return { status: "missing" as const };
                },
              },
              mutation: {
                acquireSetupLease(
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
