import { CredentialError } from "./errors.js";
import {
  type ApiOrigin,
  type ApiOriginPolicy,
  normalizeApiOrigin,
} from "./origin.js";

declare const apiKeyBrand: unique symbol;
declare const agentIdBrand: unique symbol;
declare const agentNameBrand: unique symbol;
declare const canonicalTimestampBrand: unique symbol;
declare const registrationRequestIdBrand: unique symbol;
declare const usernameBrand: unique symbol;

export type ApiKey = string & { readonly [apiKeyBrand]: true };
export type AgentId = string & { readonly [agentIdBrand]: true };
export type AgentName = string & { readonly [agentNameBrand]: true };
export type CanonicalTimestamp = string & {
  readonly [canonicalTimestampBrand]: true;
};
export type RegistrationRequestId = string & {
  readonly [registrationRequestIdBrand]: true;
};
export type Username = string & { readonly [usernameBrand]: true };

export const CREDENTIAL_SCHEMA_VERSION = 1 as const;
export const MAX_CREDENTIAL_DOCUMENT_CHARACTERS = 16_384;

interface CredentialCommonV1 {
  readonly schema_version: typeof CREDENTIAL_SCHEMA_VERSION;
  readonly api_origin: ApiOrigin;
  readonly api_key: ApiKey;
  readonly agent_name: AgentName;
  readonly created_at: CanonicalTimestamp;
  readonly updated_at: CanonicalTimestamp;
}

export interface PendingCredentialV1 extends CredentialCommonV1 {
  readonly state: "pending";
  readonly agent_id: null;
  readonly username: Username;
  readonly registration_request_id: RegistrationRequestId;
  readonly activated_at: null;
}

export interface ActiveCredentialV1 extends CredentialCommonV1 {
  readonly state: "active";
  readonly agent_id: AgentId;
  readonly username: Username | null;
  readonly registration_request_id: RegistrationRequestId | null;
  readonly activated_at: CanonicalTimestamp;
}

export type CredentialV1 = PendingCredentialV1 | ActiveCredentialV1;

const FIELDS = [
  "schema_version",
  "state",
  "api_origin",
  "api_key",
  "agent_id",
  "agent_name",
  "username",
  "registration_request_id",
  "created_at",
  "updated_at",
  "activated_at",
] as const;

const API_KEY = /^plrm_live_[A-Za-z0-9_-]{10,200}$/u;
const API_KEY_TOKEN = /plrm_live_[A-Za-z0-9_-]{10,200}/u;
const USERNAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REGISTRATION_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const NAME_DISPLAY_CONTROL = /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

function invalidDocument(): never {
  throw new CredentialError("invalid_credential_document");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === FIELDS.length &&
    keys.every((key) => FIELDS.includes(key as (typeof FIELDS)[number]))
  );
}

export function parseApiKey(input: unknown): ApiKey {
  if (typeof input !== "string" || !API_KEY.test(input)) {
    throw new CredentialError("invalid_api_key");
  }
  return input as ApiKey;
}

export function containsApiKeyToken(
  input: unknown,
  exactApiKey?: ApiKey,
): boolean {
  if (typeof input !== "string") {
    return false;
  }
  let displaySkeleton: string;
  try {
    displaySkeleton = input
      .normalize("NFKC")
      .replace(DEFAULT_IGNORABLE, "");
  } catch {
    return true;
  }
  return (
    (exactApiKey !== undefined &&
      (input.includes(exactApiKey) ||
        displaySkeleton.includes(exactApiKey))) ||
    API_KEY_TOKEN.test(input) ||
    API_KEY_TOKEN.test(displaySkeleton)
  );
}

function isApiKey(value: unknown): value is ApiKey {
  try {
    parseApiKey(value);
    return true;
  } catch {
    return false;
  }
}

function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_ID.test(value);
}

function isRegistrationRequestId(
  value: unknown,
): value is RegistrationRequestId {
  return typeof value === "string" && REGISTRATION_REQUEST_ID.test(value);
}

function isUsername(value: unknown): value is Username {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 50 &&
    USERNAME.test(value)
  );
}

function isAgentName(value: unknown): value is AgentName {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 510 ||
    NAME_CONTROL.test(value) ||
    NAME_DISPLAY_CONTROL.test(value)
  ) {
    return false;
  }
  let codePoints = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoints += 1) > 255
    ) {
      return false;
    }
  }
  return true;
}

function isCanonicalTimestamp(value: unknown): value is CanonicalTimestamp {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateOrigin(
  value: unknown,
  policy: ApiOriginPolicy,
): ApiOrigin {
  if (typeof value !== "string") {
    throw new CredentialError("invalid_credential_origin");
  }
  let normalized: ApiOrigin;
  try {
    normalized = normalizeApiOrigin(value, policy);
  } catch {
    throw new CredentialError("invalid_credential_origin");
  }
  if (normalized !== value) {
    throw new CredentialError("invalid_credential_origin");
  }
  return normalized;
}

function canonicalText(credential: CredentialV1): string {
  return `${JSON.stringify(credential, null, 2)}\n`;
}

export function validateCredentialDocument(
  input: unknown,
  originPolicy: ApiOriginPolicy = "https-only",
): CredentialV1 {
  if (!isRecord(input)) {
    return invalidDocument();
  }
  if (
    typeof input.schema_version === "number" &&
    Number.isInteger(input.schema_version) &&
    input.schema_version !== CREDENTIAL_SCHEMA_VERSION
  ) {
    throw new CredentialError("unsupported_credential_schema");
  }
  if (
    input.schema_version !== CREDENTIAL_SCHEMA_VERSION ||
    !hasExactFields(input) ||
    !isApiKey(input.api_key) ||
    !isAgentName(input.agent_name) ||
    !isCanonicalTimestamp(input.created_at) ||
    !isCanonicalTimestamp(input.updated_at) ||
    input.created_at > input.updated_at
  ) {
    return invalidDocument();
  }

  const apiOrigin = validateOrigin(input.api_origin, originPolicy);
  if (
    containsApiKeyToken(apiOrigin, input.api_key) ||
    containsApiKeyToken(input.agent_name, input.api_key) ||
    containsApiKeyToken(input.username, input.api_key)
  ) {
    return invalidDocument();
  }

  if (input.state === "pending") {
    if (
      input.agent_id !== null ||
      !isUsername(input.username) ||
      !isRegistrationRequestId(input.registration_request_id) ||
      input.activated_at !== null
    ) {
      return invalidDocument();
    }
    return Object.freeze({
      schema_version: CREDENTIAL_SCHEMA_VERSION,
      state: "pending",
      api_origin: apiOrigin,
      api_key: input.api_key,
      agent_id: null,
      agent_name: input.agent_name,
      username: input.username,
      registration_request_id: input.registration_request_id,
      created_at: input.created_at,
      updated_at: input.updated_at,
      activated_at: null,
    });
  }

  if (input.state === "active") {
    if (
      !isAgentId(input.agent_id) ||
      (input.username !== null && !isUsername(input.username)) ||
      (input.registration_request_id !== null &&
        !isRegistrationRequestId(input.registration_request_id)) ||
      !isCanonicalTimestamp(input.activated_at) ||
      input.created_at > input.activated_at ||
      input.activated_at > input.updated_at
    ) {
      return invalidDocument();
    }
    return Object.freeze({
      schema_version: CREDENTIAL_SCHEMA_VERSION,
      state: "active",
      api_origin: apiOrigin,
      api_key: input.api_key,
      agent_id: input.agent_id,
      agent_name: input.agent_name,
      username: input.username,
      registration_request_id: input.registration_request_id,
      created_at: input.created_at,
      updated_at: input.updated_at,
      activated_at: input.activated_at,
    });
  }

  return invalidDocument();
}

export function serializeCredentialDocument(
  credential: CredentialV1,
  originPolicy: ApiOriginPolicy = "https-only",
): string {
  return canonicalText(validateCredentialDocument(credential, originPolicy));
}

export function parseCredentialDocument(
  input: unknown,
  originPolicy: ApiOriginPolicy = "https-only",
): CredentialV1 {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_CREDENTIAL_DOCUMENT_CHARACTERS
  ) {
    return invalidDocument();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return invalidDocument();
  }
  const credential = validateCredentialDocument(parsed, originPolicy);
  if (input !== canonicalText(credential)) {
    return invalidDocument();
  }
  return credential;
}
