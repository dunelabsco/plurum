import {
  chmod,
  link,
  lstat,
  readdir,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPlatformPathAdapter,
  normalizeOs,
} from "../src/adapters/node/platform.js";
import {
  resolveCredentialLocations,
  type CredentialLocations,
} from "../src/credentials/paths.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
  type CredentialV1,
} from "../src/credentials/schema.js";
import { readCredentialStore } from "../src/credentials/store.js";
import type {
  CredentialCanonicalEntry,
  CredentialSetupLeaseNonce,
  CredentialTemporaryEntry,
} from "../src/credentials/store-mutation-contracts.js";
import {
  writeCredentialStore,
} from "../src/credentials/store-writer.js";
import {
  createIsolatedPosixCredentialStore,
} from "./support/isolated-posix-credential-store.js";
import {
  isPathWithin,
} from "./support/test-boundary.js";
import {
  createIsolatedTestRoot,
  isIsolatedTestEnvironmentSafe,
  type IsolatedTestRoot,
} from "./support/test-root.js";

const OLD_KEY = `plrm_live_${"O".repeat(43)}`;
const NEW_KEY = `plrm_live_${"N".repeat(43)}`;
const NONCE_1 = "b56c52f5-a090-41eb-a164-1c92e36db94f";
const NONCE_2 = "4657f2a0-739f-4923-86e8-f25f1dc328f9";
const NONCE_3 = "c5a8d21a-9679-43bd-93c7-2c476388d8aa";
const TRANSACTION_1 = "ea6c65bb-ad3e-4cf6-8afe-485786b8796c";
const TRANSACTION_2 = "5e4690c9-aa62-4a62-9e94-c3b95745df00";
const TRANSACTION_3 = "d6907173-52de-4fe6-982f-b75ce6279102";
const API_ORIGIN = "https://api.plurum.ai";
const CREATED_AT = "2026-07-19T12:00:00.000Z";
const UPDATED_AT = "2026-07-19T12:01:00.000Z";
const CREDENTIAL_ENTRY: CredentialCanonicalEntry = Object.freeze({
  kind: "canonical",
  role: "credential",
  name: "credentials.json",
});

function locationsFor(isolated: IsolatedTestRoot): CredentialLocations {
  const os = normalizeOs(process.platform);
  return resolveCredentialLocations({
    os,
    environment: isolated.environment,
    paths: createPlatformPathAdapter(os),
  });
}

function activeCredential(apiKey: string): CredentialV1 {
  return validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: API_ORIGIN,
    api_key: apiKey,
    agent_id: "123e4567-e89b-42d3-a456-426614174000",
    agent_name: "Native POSIX test",
    username: "native-posix-test",
    registration_request_id: "225f73f4-c4eb-49a6-a988-260f4bd917c5",
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    activated_at: UPDATED_AT,
  });
}

function credentialBytes(credential: CredentialV1): Uint8Array {
  return new TextEncoder().encode(
    serializeCredentialDocument(credential),
  );
}

function writerDependencies(
  storage: ReturnType<
    typeof createIsolatedPosixCredentialStore
  >["mutation"],
  uuids: readonly string[],
) {
  let index = 0;
  return Object.freeze({
    storage,
    random: Object.freeze({
      uuid(): string {
        const value = uuids[index];
        index += 1;
        if (value === undefined) {
          throw new Error("native POSIX UUID fixture was exhausted");
        }
        return value;
      },
    }),
    clock: Object.freeze({
      now: () => Date.parse(UPDATED_AT),
    }),
  });
}

function assertBoundaryStayedInside(
  isolated: IsolatedTestRoot,
): void {
  for (const operation of isolated.boundary.operations) {
    if (operation.kind === "filesystem") {
      expect(
        isPathWithin(
          isolated.paths.root,
          operation.target,
          isolated.boundary.config.platform,
        ),
      ).toBe(true);
      expect(operation.target).not.toBe(isolated.paths.outsideCanary);
    }
  }
}

async function expectCredentialStoreError(
  attempt: Promise<unknown>,
  code: "credential_store_unavailable" | "unsafe_credential_store",
): Promise<void> {
  await expect(attempt).rejects.toMatchObject({ code });
  try {
    await attempt;
  } catch (error) {
    expect(String(error)).not.toContain(OLD_KEY);
    expect(String(error)).not.toContain(NEW_KEY);
  }
}

describe.runIf(isIsolatedTestEnvironmentSafe())(
  "isolated native POSIX credential store",
  () => {
    it("creates, flushes, reads, and cleans a private credential store", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        await isolated.boundary.assertPath(
          isolated.paths.plurum,
          "delete",
        );
        await rmdir(isolated.paths.plurum);

        const locations = locationsFor(isolated);
        const native = createIsolatedPosixCredentialStore(
          isolated,
          locations,
        );
        const credential = activeCredential(NEW_KEY);

        await expect(
          writeCredentialStore(
            writerDependencies(native.mutation, [
              NONCE_1,
              TRANSACTION_1,
            ]),
            locations,
            credential,
          ),
        ).resolves.toEqual({ status: "written" });

        const loaded = await readCredentialStore(
          native.read,
          locations,
        );
        expect(loaded).toMatchObject({
          status: "loaded",
          credential: {
            state: "active",
            api_key: NEW_KEY,
            username: "native-posix-test",
          },
        });

        const directoryStats = await lstat(locations.directory);
        const credentialStats = await lstat(locations.credentials);
        expect(directoryStats.isDirectory()).toBe(true);
        expect(directoryStats.mode & 0o777).toBe(0o700);
        expect(directoryStats.uid).toBe(
          isolated.boundary.config.expectedUid,
        );
        expect(credentialStats.isFile()).toBe(true);
        expect(credentialStats.mode & 0o777).toBe(0o600);
        expect(credentialStats.uid).toBe(
          isolated.boundary.config.expectedUid,
        );
        expect(credentialStats.nlink).toBe(1);
        expect(await readdir(locations.directory)).toEqual([
          "credentials.json",
        ]);
        assertBoundaryStayedInside(isolated);
      } finally {
        await isolated.cleanup();
      }
    });

    it("atomically replaces an existing credential and makes an exact rerun a no-op", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        const locations = locationsFor(isolated);
        const native = createIsolatedPosixCredentialStore(
          isolated,
          locations,
        );
        const oldCredential = activeCredential(OLD_KEY);
        const newCredential = activeCredential(NEW_KEY);

        await writeCredentialStore(
          writerDependencies(native.mutation, [
            NONCE_1,
            TRANSACTION_1,
          ]),
          locations,
          oldCredential,
        );
        const oldStats = await lstat(locations.credentials);

        await expect(
          writeCredentialStore(
            writerDependencies(native.mutation, [
              NONCE_2,
              TRANSACTION_2,
            ]),
            locations,
            newCredential,
          ),
        ).resolves.toEqual({ status: "written" });
        const newStats = await lstat(locations.credentials);
        expect(newStats.ino).not.toBe(oldStats.ino);

        await expect(
          writeCredentialStore(
            writerDependencies(native.mutation, [
              NONCE_3,
              TRANSACTION_3,
            ]),
            locations,
            newCredential,
          ),
        ).resolves.toEqual({ status: "unchanged" });
        const unchangedStats = await lstat(locations.credentials);
        expect(unchangedStats.ino).toBe(newStats.ino);
        expect(await readdir(locations.directory)).toEqual([
          "credentials.json",
        ]);
        assertBoundaryStayedInside(isolated);
      } finally {
        await isolated.cleanup();
      }
    });

    it("serializes a live lease and never reclaims an unknown existing lock", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        const locations = locationsFor(isolated);
        const native = createIsolatedPosixCredentialStore(
          isolated,
          locations,
        );
        const first = await native.mutation.acquireSetupLease(
          locations.directory,
          Object.freeze({
            noFollow: true,
            createDirectory: true,
            nonce: NONCE_1 as CredentialSetupLeaseNonce,
          }),
        );
        expect(first.status).toBe("acquired");
        if (first.status !== "acquired") {
          throw new Error("native POSIX test lease was not acquired");
        }

        await expect(
          native.mutation.acquireSetupLease(
            locations.directory,
            Object.freeze({
              noFollow: true,
              createDirectory: true,
              nonce: NONCE_2 as CredentialSetupLeaseNonce,
            }),
          ),
        ).resolves.toEqual({ status: "busy" });
        await first.lease.release();

        await isolated.boundary.assertPath(
          locations.setupLock,
          "write",
        );
        await writeFile(locations.setupLock, "unknown prior owner\n", {
          flag: "wx",
          mode: 0o600,
        });
        await chmod(locations.setupLock, 0o600);

        await expect(
          native.mutation.acquireSetupLease(
            locations.directory,
            Object.freeze({
              noFollow: true,
              createDirectory: true,
              nonce: NONCE_3 as CredentialSetupLeaseNonce,
            }),
          ),
        ).resolves.toEqual({ status: "busy" });
        expect(await readdir(locations.directory)).toEqual([
          "setup.lock",
        ]);
        assertBoundaryStayedInside(isolated);
      } finally {
        await isolated.cleanup();
      }
    });

    it("invalidates lease-minted read handles when the lease terminates", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        const locations = locationsFor(isolated);
        const bytes = credentialBytes(activeCredential(OLD_KEY));
        await isolated.boundary.assertPath(
          locations.credentials,
          "write",
        );
        await writeFile(locations.credentials, bytes, {
          flag: "wx",
          mode: 0o600,
        });
        await chmod(locations.credentials, 0o600);
        bytes.fill(0);

        const native = createIsolatedPosixCredentialStore(
          isolated,
          locations,
        );
        const acquired = await native.mutation.acquireSetupLease(
          locations.directory,
          Object.freeze({
            noFollow: true,
            createDirectory: true,
            nonce: NONCE_1 as CredentialSetupLeaseNonce,
          }),
        );
        expect(acquired.status).toBe("acquired");
        if (acquired.status !== "acquired") {
          throw new Error("native POSIX test lease was not acquired");
        }
        const observation = await acquired.lease.observeEntry(
          CREDENTIAL_ENTRY,
        );
        expect(observation.status).toBe("opened");
        if (observation.status !== "opened") {
          throw new Error("native POSIX credential was not opened");
        }

        await acquired.lease.release();
        await expect(observation.file.attest()).rejects.toThrow(
          "isolated POSIX credential-store fixture failed",
        );

        const reacquired = await native.mutation.acquireSetupLease(
          locations.directory,
          Object.freeze({
            noFollow: true,
            createDirectory: true,
            nonce: NONCE_2 as CredentialSetupLeaseNonce,
          }),
        );
        expect(reacquired.status).toBe("acquired");
        if (reacquired.status === "acquired") {
          await reacquired.lease.release();
        }
        expect(await readdir(locations.directory)).toEqual([
          "credentials.json",
        ]);
      } finally {
        await isolated.cleanup();
      }
    });

    it("can release cleanly after a generic lease operation error", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        const locations = locationsFor(isolated);
        const native = createIsolatedPosixCredentialStore(
          isolated,
          locations,
        );
        const acquired = await native.mutation.acquireSetupLease(
          locations.directory,
          Object.freeze({
            noFollow: true,
            createDirectory: true,
            nonce: NONCE_1 as CredentialSetupLeaseNonce,
          }),
        );
        expect(acquired.status).toBe("acquired");
        if (acquired.status !== "acquired") {
          throw new Error("native POSIX test lease was not acquired");
        }

        await expect(
          acquired.lease.observeEntry(
            Object.freeze({
              ...CREDENTIAL_ENTRY,
              unexpected: true,
            }) as unknown as CredentialCanonicalEntry,
          ),
        ).rejects.toThrow(
          "isolated POSIX credential-store fixture failed",
        );
        await expect(acquired.lease.release()).resolves.toBeUndefined();

        const reacquired = await native.mutation.acquireSetupLease(
          locations.directory,
          Object.freeze({
            noFollow: true,
            createDirectory: true,
            nonce: NONCE_2 as CredentialSetupLeaseNonce,
          }),
        );
        expect(reacquired.status).toBe("acquired");
        if (reacquired.status === "acquired") {
          await reacquired.lease.release();
        }
        expect(await readdir(locations.directory)).toEqual([]);
      } finally {
        await isolated.cleanup();
      }
    });

    it("fails closed when the setup lock disappears during a lease", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        const locations = locationsFor(isolated);
        const native = createIsolatedPosixCredentialStore(
          isolated,
          locations,
        );
        const acquired = await native.mutation.acquireSetupLease(
          locations.directory,
          Object.freeze({
            noFollow: true,
            createDirectory: true,
            nonce: NONCE_1 as CredentialSetupLeaseNonce,
          }),
        );
        expect(acquired.status).toBe("acquired");
        if (acquired.status !== "acquired") {
          throw new Error("native POSIX test lease was not acquired");
        }

        await isolated.boundary.assertPath(
          locations.setupLock,
          "delete",
        );
        await unlink(locations.setupLock);

        await expect(
          acquired.lease.observeEntry(CREDENTIAL_ENTRY),
        ).rejects.toThrow(
          "isolated POSIX credential-store fixture failed",
        );
        await expect(acquired.lease.release()).rejects.toThrow(
          "isolated POSIX credential-store fixture failed",
        );
        await expect(
          native.mutation.acquireSetupLease(
            locations.directory,
            Object.freeze({
              noFollow: true,
              createDirectory: true,
              nonce: NONCE_2 as CredentialSetupLeaseNonce,
            }),
          ),
        ).resolves.toEqual({ status: "busy" });
        expect(await readdir(locations.directory)).toEqual([
          "setup.lock",
        ]);
        assertBoundaryStayedInside(isolated);
      } finally {
        await isolated.cleanup();
      }
    });

    it("invalidates lease-minted write handles when the lease terminates", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        const locations = locationsFor(isolated);
        const native = createIsolatedPosixCredentialStore(
          isolated,
          locations,
        );
        const acquired = await native.mutation.acquireSetupLease(
          locations.directory,
          Object.freeze({
            noFollow: true,
            createDirectory: true,
            nonce: NONCE_1 as CredentialSetupLeaseNonce,
          }),
        );
        expect(acquired.status).toBe("acquired");
        if (acquired.status !== "acquired") {
          throw new Error("native POSIX test lease was not acquired");
        }

        const entry = Object.freeze({
          kind: "temporary",
          role: "credential-candidate",
          transactionId: TRANSACTION_1,
        }) as CredentialTemporaryEntry;
        const observed = await acquired.lease.observeEntry(entry);
        expect(observed.status).toBe("missing");
        if (observed.status !== "missing") {
          throw new Error("native POSIX candidate unexpectedly existed");
        }
        const created =
          await acquired.lease.createTemporaryExclusive(
            Object.freeze({
              entry,
              expected: observed.snapshot,
            }),
          );
        expect(created.status).toBe("created");
        if (created.status !== "created") {
          throw new Error("native POSIX candidate was not created");
        }

        await acquired.lease.release();
        await expect(created.file.attest()).rejects.toThrow(
          "isolated POSIX credential-store fixture failed",
        );

        const reacquired = await native.mutation.acquireSetupLease(
          locations.directory,
          Object.freeze({
            noFollow: true,
            createDirectory: true,
            nonce: NONCE_2 as CredentialSetupLeaseNonce,
          }),
        );
        expect(reacquired.status).toBe("acquired");
        if (reacquired.status === "acquired") {
          await reacquired.lease.release();
        }
        assertBoundaryStayedInside(isolated);
      } finally {
        await isolated.cleanup();
      }
    });

    it("refuses broader, special-bit, and hard-linked credential files without repairing them", async () => {
      for (const unsafeKind of [
        "broader",
        "special-bits",
        "hard-link",
      ] as const) {
        const isolated = await createIsolatedTestRoot();
        try {
          const locations = locationsFor(isolated);
          const source = join(
            locations.directory,
            "fixture-source.json",
          );
          const bytes = credentialBytes(activeCredential(OLD_KEY));

          if (
            unsafeKind === "broader" ||
            unsafeKind === "special-bits"
          ) {
            await isolated.boundary.assertPath(
              locations.credentials,
              "write",
            );
            await writeFile(locations.credentials, bytes, {
              flag: "wx",
              mode: unsafeKind === "broader" ? 0o644 : 0o1600,
            });
            await chmod(
              locations.credentials,
              unsafeKind === "broader" ? 0o644 : 0o1600,
            );
          } else {
            await isolated.boundary.assertPath(source, "write");
            await writeFile(source, bytes, {
              flag: "wx",
              mode: 0o600,
            });
            await chmod(source, 0o600);
            await isolated.boundary.assertPath(source, "read");
            await isolated.boundary.assertPath(
              locations.credentials,
              "write",
            );
            await link(source, locations.credentials);
          }
          bytes.fill(0);

          const native = createIsolatedPosixCredentialStore(
            isolated,
            locations,
          );
          await expectCredentialStoreError(
            readCredentialStore(native.read, locations),
            unsafeKind === "hard-link"
              ? "credential_store_unavailable"
              : "unsafe_credential_store",
          );

          const stats = await lstat(locations.credentials);
          if (unsafeKind === "broader") {
            expect(stats.mode & 0o777).toBe(0o644);
          } else if (unsafeKind === "special-bits") {
            expect(stats.mode & 0o7777).toBe(0o1600);
          } else {
            expect(stats.nlink).toBe(2);
          }
          assertBoundaryStayedInside(isolated);
        } finally {
          await isolated.cleanup();
        }
      }
    });

    it("refuses a symlinked credential without touching its outside target", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        const locations = locationsFor(isolated);
        await isolated.boundary.assertPath(
          locations.credentials,
          "write",
        );
        await symlink(
          isolated.paths.outsideCanary,
          locations.credentials,
        );

        const native = createIsolatedPosixCredentialStore(
          isolated,
          locations,
        );
        await expectCredentialStoreError(
          readCredentialStore(native.read, locations),
          "credential_store_unavailable",
        );
        expect(
          (await lstat(locations.credentials)).isSymbolicLink(),
        ).toBe(true);
        assertBoundaryStayedInside(isolated);
      } finally {
        await isolated.cleanup();
      }
    });
  },
);
