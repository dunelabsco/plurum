import process from "node:process";

import type {
  CredentialEnvironmentAdapter,
  CredentialEnvironmentSnapshot,
} from "../../system/contracts.js";
import {
  copyCredentialEnvironmentSnapshot,
  CREDENTIAL_ENVIRONMENT_KEYS,
} from "../../system/credential-environment.js";

type CredentialEnvironmentKey =
  (typeof CREDENTIAL_ENVIRONMENT_KEYS)[number];

export function selectCredentialEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): CredentialEnvironmentSnapshot {
  const selected: Partial<Record<CredentialEnvironmentKey, string>> = {};
  for (const key of CREDENTIAL_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return copyCredentialEnvironmentSnapshot(selected);
}

export const nodeCredentialEnvironment: CredentialEnvironmentAdapter =
  Object.freeze({
    read(): CredentialEnvironmentSnapshot {
      return selectCredentialEnvironment(process.env);
    },
  });
