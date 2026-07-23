export const LEGACY_CREDENTIAL_SOURCES = Object.freeze(
  ["hermes", "openclaw", "removed-cli"] as const,
);

export type LegacyCredentialSource =
  (typeof LEGACY_CREDENTIAL_SOURCES)[number];

export const MAX_LEGACY_CREDENTIAL_BYTES = 16_384;

export interface LegacyCredentialReadOptions {
  readonly noFollow: true;
  readonly maxBytes: typeof MAX_LEGACY_CREDENTIAL_BYTES;
}

export type LegacyCredentialAdapterReadResult =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "unsafe" }>
  | Readonly<{ status: "malformed" }>
  | Readonly<{
      status: "loaded";
      /*
       * The adapter retains ownership of this buffer. Portable code copies it
       * synchronously after the read promise resolves and never mutates it.
       */
      bytes: Uint8Array;
    }>;

/*
 * Implementations must perform a bounded, no-follow read of the exact
 * allowlisted source path and classify any ownership, access, link, binding,
 * or stability failure as unsafe. Empty, oversized, truncated, or otherwise
 * structurally unreadable source bytes are malformed. This port has no
 * mutation or repair method.
 */
export interface LegacyCredentialReadAdapter {
  read(
    source: LegacyCredentialSource,
    path: string,
    options: LegacyCredentialReadOptions,
  ): Promise<LegacyCredentialAdapterReadResult>;
}
