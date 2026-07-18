import { describe, expect, it } from "vitest";

import { CredentialError } from "../src/credentials/errors.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import {
  decodeCredentialDocumentBytes,
  MAX_CREDENTIAL_DOCUMENT_BYTES,
} from "../src/credentials/store-codec.js";
import { readCredentialStore } from "../src/credentials/store.js";
import type {
  CredentialFileAttestation,
  CredentialFileReadHandle,
  CredentialStoreReadAdapter,
  PrivateCredentialDirectoryHandle,
} from "../src/credentials/store-contracts.js";
import {
  createInMemoryCredentialStore,
  secureDirectoryAttestation,
  secureFileAttestation,
  type CredentialStoreFakeOperation,
} from "./support/in-memory-credential-store.js";

const API_KEY = `plrm_live_${"A".repeat(43)}`;
const LOCATIONS = Object.freeze({ directory: "/isolated/plurum" });

function credentialText(schemaVersion = 1): string {
  const canonical = serializeCredentialDocument(
    validateCredentialDocument({
      schema_version: 1,
      state: "active",
      api_origin: DEFAULT_API_ORIGIN,
      api_key: API_KEY,
      agent_id: "123e4567-e89b-42d3-a456-426614174000",
      agent_name: "Codex",
      username: "codex-42",
      registration_request_id: "ca908d9f-d901-4dac-b396-7f84377adfc8",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:01:00.000Z",
      activated_at: "2026-07-16T12:01:00.000Z",
    }),
  );
  return schemaVersion === 1
    ? canonical
    : canonical.replace(
        '  "schema_version": 1,',
        `  "schema_version": ${schemaVersion},`,
      );
}

function pendingCredentialText(): string {
  return serializeCredentialDocument(
    validateCredentialDocument({
      schema_version: 1,
      state: "pending",
      api_origin: DEFAULT_API_ORIGIN,
      api_key: API_KEY,
      agent_id: null,
      agent_name: "Codex",
      username: "codex-42",
      registration_request_id: "ca908d9f-d901-4dac-b396-7f84377adfc8",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
      activated_at: null,
    }),
  );
}

function encoded(text = credentialText()): Uint8Array {
  return new TextEncoder().encode(text);
}

async function expectStoreError(
  attempt: Promise<unknown>,
  code: "credential_store_unavailable" | "unsafe_credential_store",
): Promise<void> {
  await expect(attempt).rejects.toMatchObject({ code });
}

describe("portable credential-store read core", () => {
  it("loads a canonical credential through no-follow bounded handles", async () => {
    const bytes = encoded();
    const fake = createInMemoryCredentialStore({ bytes });

    const result = await readCredentialStore(fake.adapter, LOCATIONS);

    expect(result).toMatchObject({
      status: "loaded",
      credential: {
        api_origin: DEFAULT_API_ORIGIN,
        api_key: API_KEY,
        agent_name: "Codex",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      result.status === "loaded" && Object.isFrozen(result.credential),
    ).toBe(true);
    expect(fake.trace.operations()).toEqual([
      "open-directory",
      "attest-directory:1",
      "open-credential",
      "attest-file:1",
      "read-file",
      "attest-file:2",
      "close-file",
      "attest-directory:2",
      "close-directory",
    ]);
    expect(fake.trace.directories()).toEqual(["/isolated/plurum"]);
    expect(fake.trace.directoryOpenOptions()).toEqual([{ noFollow: true }]);
    expect(fake.trace.credentialOpenOptions()).toEqual([
      { entry: "credentials.json", noFollow: true },
    ]);
    expect(fake.trace.readOptions()).toEqual([
      { maxBytes: MAX_CREDENTIAL_DOCUMENT_BYTES + 1 },
    ]);
    expect(Object.isFrozen(fake.trace.directoryOpenOptions()[0])).toBe(true);
    expect(Object.isFrozen(fake.trace.credentialOpenOptions()[0])).toBe(true);
    expect(Object.isFrozen(fake.trace.readOptions()[0])).toBe(true);
  });

  it("copies adapter-owned bytes before any later await", async () => {
    const bytes = encoded();
    const original = bytes.slice();
    const fake = createInMemoryCredentialStore({
      bytes,
      onOperation(operation) {
        if (operation === "attest-file:2") {
          bytes.fill(0);
        }
      },
    });

    const result = await readCredentialStore(fake.adapter, LOCATIONS);

    expect(result.status).toBe("loaded");
    expect(bytes).not.toEqual(original);
  });

  it("loads the canonical pending credential state without activating it", async () => {
    const fake = createInMemoryCredentialStore({
      bytes: encoded(pendingCredentialText()),
    });
    await expect(readCredentialStore(fake.adapter, LOCATIONS)).resolves.toMatchObject({
      status: "loaded",
      credential: {
        state: "pending",
        agent_id: null,
        activated_at: null,
      },
    });
  });

  it("distinguishes only explicit directory and credential absence", async () => {
    const absentDirectory = createInMemoryCredentialStore({
      directoryMissing: true,
    });
    const directoryResult = await readCredentialStore(
      absentDirectory.adapter,
      LOCATIONS,
    );
    expect(directoryResult).toEqual({
      status: "missing",
      reason: "directory_missing",
    });
    expect(Object.isFrozen(directoryResult)).toBe(true);
    expect(absentDirectory.trace.operations()).toEqual(["open-directory"]);

    const absentCredential = createInMemoryCredentialStore({
      credentialMissing: true,
    });
    const credentialResult = await readCredentialStore(
      absentCredential.adapter,
      LOCATIONS,
    );
    expect(credentialResult).toEqual({
      status: "missing",
      reason: "credential_missing",
    });
    expect(Object.isFrozen(credentialResult)).toBe(true);
    expect(absentCredential.trace.operations()).toEqual([
      "open-directory",
      "attest-directory:1",
      "open-credential",
      "attest-directory:2",
      "close-directory",
    ]);
  });

  it.each([
    secureDirectoryAttestation({ owner: "other-user" }),
    secureDirectoryAttestation({ owner: "unknown" }),
    secureDirectoryAttestation({ access: "broader" }),
    secureDirectoryAttestation({ access: "unknown" }),
    secureDirectoryAttestation({ link: "symbolic-link" }),
    secureDirectoryAttestation({ link: "reparse-point" }),
    secureDirectoryAttestation({ link: "unknown" }),
    secureDirectoryAttestation({ binding: "detached" }),
    secureDirectoryAttestation({ binding: "unknown" }),
    secureDirectoryAttestation({ revision: "" }),
    secureDirectoryAttestation({
      identity: { volume: "", object: "directory" },
    }),
  ])("fails closed on unsafe directory attestation %#", async (attestation) => {
    const fake = createInMemoryCredentialStore({
      directoryAttestations: [attestation],
    });
    await expectStoreError(
      readCredentialStore(fake.adapter, LOCATIONS),
      "unsafe_credential_store",
    );
    expect(fake.trace.operations().at(-1)).toBe("close-directory");
    expect(
      fake.trace.operations().filter((item) => item === "close-directory"),
    ).toHaveLength(1);
    expect(fake.trace.operations()).not.toContain("open-credential");
  });

  it.each([
    (size: number) => secureFileAttestation(size, { owner: "other-user" }),
    (size: number) => secureFileAttestation(size, { access: "broader" }),
    (size: number) =>
      secureFileAttestation(size, { link: "symbolic-link" }),
    (size: number) =>
      secureFileAttestation(size, { link: "reparse-point" }),
    (size: number) => secureFileAttestation(size, { binding: "detached" }),
    (size: number) => secureFileAttestation(size, { links: 2 }),
    (size: number) =>
      secureFileAttestation(size, {
        parentIdentity: { volume: "memory-volume", object: "replacement" },
      }),
    (size: number) =>
      secureFileAttestation(size, {
        identity: {
          volume: "memory-volume",
          object: "credential-directory",
        },
      }),
    (size: number) => secureFileAttestation(size, { revision: "" }),
  ])("fails closed before reading an unsafe credential file", async (makeAttestation) => {
    const bytes = encoded();
    const fake = createInMemoryCredentialStore({
      bytes,
      fileAttestations: [makeAttestation(bytes.byteLength)],
    });
    await expectStoreError(
      readCredentialStore(fake.adapter, LOCATIONS),
      "unsafe_credential_store",
    );
    expect(fake.trace.operations()).not.toContain("read-file");
    expect(
      fake.trace.operations().filter((item) => item === "close-file"),
    ).toHaveLength(1);
    expect(
      fake.trace.operations().filter((item) => item === "close-directory"),
    ).toHaveLength(1);
  });

  it("classifies an empty protected file as an invalid document", async () => {
    const fake = createInMemoryCredentialStore({ bytes: new Uint8Array() });
    await expect(readCredentialStore(fake.adapter, LOCATIONS)).rejects.toMatchObject({
      code: "invalid_credential_document",
    });
    expect(fake.trace.operations()).toContain("read-file");
    expect(fake.trace.operations().filter((item) => item === "close-file")).toHaveLength(
      1,
    );
  });

  it("rejects an oversized protected file before reading it", async () => {
    const fake = createInMemoryCredentialStore({
      fileAttestations: [
        secureFileAttestation(MAX_CREDENTIAL_DOCUMENT_BYTES + 1),
      ],
    });
    await expect(readCredentialStore(fake.adapter, LOCATIONS)).rejects.toMatchObject({
      code: "credential_document_too_large",
    });
    expect(fake.trace.operations()).not.toContain("read-file");
    expect(fake.trace.operations().filter((item) => item === "close-file")).toHaveLength(
      1,
    );
  });

  it("rejects same-identity same-size content revision changes", async () => {
    const bytes = encoded();
    const fake = createInMemoryCredentialStore({
      bytes,
      fileAttestations: [
        secureFileAttestation(bytes.byteLength),
        secureFileAttestation(bytes.byteLength, {
          revision: "file-revision-2",
        }),
      ],
    });
    await expectStoreError(
      readCredentialStore(fake.adapter, LOCATIONS),
      "unsafe_credential_store",
    );
    expect(fake.trace.operations().filter((item) => item === "close-file")).toHaveLength(
      1,
    );
  });

  it("rejects a detached or replaced canonical directory after the read", async () => {
    const bytes = encoded();
    const fake = createInMemoryCredentialStore({
      bytes,
      directoryAttestations: [
        secureDirectoryAttestation(),
        secureDirectoryAttestation({
          revision: "directory-revision-2",
          binding: "detached",
        }),
      ],
    });
    await expectStoreError(
      readCredentialStore(fake.adapter, LOCATIONS),
      "unsafe_credential_store",
    );
    expect(fake.trace.operations().at(-1)).toBe("close-directory");
  });

  it.each([
    {
      label: "non-EOF bounded result",
      make: (bytes: Uint8Array) =>
        createInMemoryCredentialStore({ bytes, endOfFile: false }),
    },
    {
      label: "attested-size mismatch",
      make: (bytes: Uint8Array) =>
        createInMemoryCredentialStore({
          bytes,
          fileAttestations: [secureFileAttestation(bytes.byteLength - 1)],
        }),
    },
  ])("rejects $label", async ({ make }) => {
    await expectStoreError(
      readCredentialStore(make(encoded()).adapter, LOCATIONS),
      "unsafe_credential_store",
    );
  });

  it.each([
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xef, 0xbb, 0xbf, ...encoded()]),
    encoded(credentialText().trimEnd()),
    encoded(credentialText().trimEnd() + "\r\n"),
  ])("rejects malformed UTF-8 or non-canonical bytes", async (bytes) => {
    const fake = createInMemoryCredentialStore({ bytes });
    await expect(readCredentialStore(fake.adapter, LOCATIONS)).rejects.toMatchObject({
      code: "invalid_credential_document",
    });
    expect(fake.trace.operations().filter((item) => item === "close-file")).toHaveLength(
      1,
    );
    expect(
      fake.trace.operations().filter((item) => item === "close-directory"),
    ).toHaveLength(1);
  });

  it("preserves unsupported-schema failure instead of treating it as missing", async () => {
    const bytes = encoded(credentialText(2));
    const fake = createInMemoryCredentialStore({ bytes });
    await expect(readCredentialStore(fake.adapter, LOCATIONS)).rejects.toMatchObject({
      code: "unsupported_credential_schema",
    });
    expect(fake.trace.operations()).toContain("read-file");
  });

  it("strictly bounds the byte codec and does not strip a BOM", () => {
    expect(() => decodeCredentialDocumentBytes(new Uint8Array())).toThrowError(
      expect.objectContaining({ code: "invalid_credential_document" }),
    );
    expect(() =>
      decodeCredentialDocumentBytes(
        new Uint8Array(MAX_CREDENTIAL_DOCUMENT_BYTES + 1),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_credential_document" }),
    );
    expect(
      decodeCredentialDocumentBytes(
        new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      ).charCodeAt(0),
    ).toBe(0xfeff);
  });

  it.each([
    "open-directory",
    "attest-directory:1",
    "open-credential",
    "attest-file:1",
    "read-file",
    "attest-file:2",
    "close-file",
    "attest-directory:2",
    "close-directory",
  ] satisfies readonly CredentialStoreFakeOperation[])(
    "sanitizes adapter failures at %s and closes every acquired handle",
    async (failAt) => {
      const reflectedSecret = `${API_KEY} /Users/private/credentials.json`;
      const fake = createInMemoryCredentialStore({
        bytes: encoded(),
        failAt: [failAt],
        failureMessage: reflectedSecret,
      });

      try {
        await readCredentialStore(fake.adapter, LOCATIONS);
        throw new Error("failing adapter unexpectedly succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialError);
        expect(error).toMatchObject({ code: "credential_store_unavailable" });
        expect(String(error)).not.toContain(API_KEY);
        expect(String(error)).not.toContain("/Users/private");
        expect(JSON.stringify(error)).not.toContain(reflectedSecret);
      }

      const operations = fake.trace.operations();
      const fileWasOpened = operations.includes("attest-file:1");
      const directoryWasOpened = operations.includes("attest-directory:1");
      expect(operations.filter((item) => item === "close-file").length).toBe(
        fileWasOpened && failAt !== "close-file" ? 1 : failAt === "close-file" ? 1 : 0,
      );
      expect(
        operations.filter((item) => item === "close-directory").length,
      ).toBe(
        directoryWasOpened && failAt !== "close-directory"
          ? 1
          : failAt === "close-directory"
            ? 1
            : 0,
      );
    },
  );

  it("closes contradictory missing-result handles exactly once", async () => {
    let directoryCloses = 0;
    const contradictoryDirectory = {
      async close() {
        directoryCloses += 1;
      },
    };
    const directoryAdapter = {
      async openPrivateDirectory() {
        return {
          status: "missing",
          directory: contradictoryDirectory,
        };
      },
    } as unknown as CredentialStoreReadAdapter;
    await expectStoreError(
      readCredentialStore(directoryAdapter, LOCATIONS),
      "credential_store_unavailable",
    );
    expect(directoryCloses).toBe(1);

    let fileCloses = 0;
    let outerDirectoryCloses = 0;
    const contradictoryFile = {
      async close() {
        fileCloses += 1;
      },
    };
    const directory: PrivateCredentialDirectoryHandle = {
      async attest() {
        return secureDirectoryAttestation();
      },
      async openCredentialReadOnly() {
        return {
          status: "missing",
          file: contradictoryFile,
        } as never;
      },
      async close() {
        outerDirectoryCloses += 1;
      },
    };
    const fileAdapter: CredentialStoreReadAdapter = {
      async openPrivateDirectory() {
        return { status: "opened", directory };
      },
    };
    await expectStoreError(
      readCredentialStore(fileAdapter, LOCATIONS),
      "credential_store_unavailable",
    );
    expect(fileCloses).toBe(1);
    expect(outerDirectoryCloses).toBe(1);
  });

  it("sanitizes hostile result getters without reflecting their errors", async () => {
    const reflectedSecret = `${API_KEY}/private/path`;
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(reflectedSecret);
        },
      },
    );
    const adapter = {
      async openPrivateDirectory() {
        return hostile;
      },
    } as unknown as CredentialStoreReadAdapter;

    try {
      await readCredentialStore(adapter, LOCATIONS);
      throw new Error("hostile result unexpectedly succeeded");
    } catch (error) {
      expect(error).toMatchObject({ code: "credential_store_unavailable" });
      expect(String(error)).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain(reflectedSecret);
    }
  });

  it("rejects array-shaped adapter results instead of treating them as records", async () => {
    const arrayResult: unknown[] & { status?: string } = [];
    arrayResult.status = "missing";
    const adapter = {
      async openPrivateDirectory() {
        return arrayResult;
      },
    } as unknown as CredentialStoreReadAdapter;

    await expectStoreError(
      readCredentialStore(adapter, LOCATIONS),
      "credential_store_unavailable",
    );
  });

  it("snapshots each hostile attestation property once per attestation", async () => {
    const bytes = encoded();
    let sizeReads = 0;
    const hostileAttestation = {
      ...secureFileAttestation(bytes.byteLength),
      get size() {
        sizeReads += 1;
        return sizeReads === 1
          ? bytes.byteLength
          : bytes.byteLength + 1;
      },
    } as CredentialFileAttestation;
    const fake = createInMemoryCredentialStore({
      bytes,
      fileAttestations: [hostileAttestation],
    });

    await expectStoreError(
      readCredentialStore(fake.adapter, LOCATIONS),
      "unsafe_credential_store",
    );
    expect(sizeReads).toBe(2);
    expect(fake.trace.operations()).toContain("read-file");
  });

  it("never trusts a mutable bounded-read bytes getter twice", async () => {
    const bytes = encoded();
    let bytesReads = 0;
    let fileCloses = 0;
    let directoryCloses = 0;
    const file: CredentialFileReadHandle = {
      async attest(): Promise<CredentialFileAttestation> {
        return secureFileAttestation(bytes.byteLength);
      },
      async readBounded() {
        return {
          get bytes() {
            bytesReads += 1;
            return bytesReads === 1 ? bytes : new Uint8Array(bytes.byteLength);
          },
          endOfFile: true,
        };
      },
      async close() {
        fileCloses += 1;
      },
    };
    const directory: PrivateCredentialDirectoryHandle = {
      async attest() {
        return secureDirectoryAttestation();
      },
      async openCredentialReadOnly() {
        return { status: "opened", file };
      },
      async close() {
        directoryCloses += 1;
      },
    };
    const adapter: CredentialStoreReadAdapter = {
      async openPrivateDirectory() {
        return { status: "opened", directory };
      },
    };

    await expect(readCredentialStore(adapter, LOCATIONS)).resolves.toMatchObject({
      status: "loaded",
    });
    expect(bytesReads).toBe(1);
    expect(fileCloses).toBe(1);
    expect(directoryCloses).toBe(1);
  });
});
