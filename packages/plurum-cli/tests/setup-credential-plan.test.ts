import { describe, expect, it } from "vitest";

import { createSetupApprovalAuthority } from "../src/commands/setup-approval.js";
import {
  SetupCredentialPlanError,
  planSetupCredential,
  type SetupCanonicalCredentialObservation,
  type SetupCredentialCandidate,
  type SetupCredentialPlanningDecision,
  type SetupCredentialPlanningObservation,
  type SetupCredentialPlanningRequest,
  type SetupCredentialSource,
} from "../src/commands/setup-credential-plan.js";
import type {
  CredentialKeyFingerprint,
} from "../src/credentials/fingerprint.js";
import {
  DEFAULT_API_ORIGIN,
  type ApiOrigin,
  normalizeApiOrigin,
} from "../src/credentials/origin.js";

const AGENT_A = "00000000-0000-4000-8000-000000000001";
const AGENT_B = "00000000-0000-4000-8000-000000000002";
const FINGERPRINT_A =
  "plurum-fp-v1:111111111111" as CredentialKeyFingerprint;
const FINGERPRINT_B =
  "plurum-fp-v1:222222222222" as CredentialKeyFingerprint;
const OTHER_ORIGIN = normalizeApiOrigin("https://other.example");
const CANARY = "plrm_live_SETUP_PLAN_CANARY_123456";
const FIXED_ERROR =
  "The setup credential plan could not be created safely.";

function setupCandidate(
  index: number,
  options: Readonly<{
    apiOrigin?: ApiOrigin;
    fingerprint?: CredentialKeyFingerprint;
    id?: string;
    name?: string;
    username?: string | null;
    sources?: readonly SetupCredentialSource[];
  }> = {},
): SetupCredentialCandidate {
  return {
    selectionId: `credential-${index}`,
    apiOrigin: options.apiOrigin ?? DEFAULT_API_ORIGIN,
    fingerprint:
      options.fingerprint ??
      (index === 1 ? FINGERPRINT_A : FINGERPRINT_B),
    agent: {
      id: options.id ?? (index === 1 ? AGENT_A : AGENT_B),
      name: options.name ?? (index === 1 ? "Codex" : "Claude Code"),
      username:
        options.username === undefined
          ? index === 1
            ? "codex-agent"
            : "claude-agent"
          : options.username,
    },
    sources: options.sources ?? ["environment"],
  };
}

function setupObservation(
  options: Readonly<{
    transaction?: SetupCredentialPlanningObservation["transaction"];
    canonical?: SetupCanonicalCredentialObservation;
    candidates?: readonly SetupCredentialCandidate[];
    blockers?: SetupCredentialPlanningObservation["blockers"];
    invalidSources?: readonly SetupCredentialSource[];
  }> = {},
): SetupCredentialPlanningObservation {
  return {
    schemaVersion: 1,
    transaction: options.transaction ?? "clean",
    canonical: options.canonical ?? { status: "missing" },
    candidates: options.candidates ?? [],
    blockers: options.blockers ?? [],
    invalidSources: options.invalidSources ?? [],
  };
}

function setupDecision(
  options: Readonly<{
    selectedCandidateId?: string | null;
    registration?: SetupCredentialPlanningDecision["registration"];
  }> = {},
): SetupCredentialPlanningDecision {
  return {
    selectedCandidateId: options.selectedCandidateId ?? null,
    registration: options.registration ?? null,
  };
}

function plan(
  observation: SetupCredentialPlanningObservation,
  decision: SetupCredentialPlanningDecision = setupDecision(),
) {
  return planSetupCredential({ observation, decision });
}

function expectFixedFailure(value: unknown): void {
  expect(() =>
    planSetupCredential(value as SetupCredentialPlanningRequest),
  ).toThrow(FIXED_ERROR);
}

describe("setup credential plan", () => {
  it("reuses one exact valid canonical credential", () => {
    const candidate = setupCandidate(1, {
      sources: ["canonical", "environment"],
    });
    const result = plan(
      setupObservation({
        canonical: {
          status: "active-valid",
          candidateSelectionId: "credential-1",
        },
        candidates: [candidate],
      }),
    );

    expect(result).toEqual({
      status: "resolved",
      disposition: "reuse",
      acquisition: "existing",
      canonicalEffect: "unchanged",
      reason: "canonical-credential-valid",
      apiOrigin: DEFAULT_API_ORIGIN,
      credential: {
        ...candidate,
        sources: ["environment", "canonical"],
      },
      invalidSources: [],
    });
  });

  it("adopts one validated noncanonical credential", () => {
    const candidate = setupCandidate(1, {
      sources: ["openclaw", "environment"],
    });
    const result = plan(
      setupObservation({ candidates: [candidate] }),
    );

    expect(result).toMatchObject({
      status: "resolved",
      disposition: "adopt",
      acquisition: "existing",
      canonicalEffect: "create",
      reason: "canonical-credential-missing",
      apiOrigin: DEFAULT_API_ORIGIN,
      credential: {
        selectionId: "credential-1",
        sources: ["environment", "openclaw"],
      },
    });
  });

  it("replaces a definitively invalid canonical credential with a validated credential", () => {
    const result = plan(
      setupObservation({
        canonical: { status: "active-invalid" },
        candidates: [setupCandidate(1, { sources: ["hermes"] })],
        invalidSources: ["canonical"],
      }),
    );

    expect(result).toMatchObject({
      status: "resolved",
      disposition: "replace",
      acquisition: "existing",
      canonicalEffect: "replace",
      reason: "canonical-credential-invalid",
      invalidSources: ["canonical"],
    });
  });

  it("requires an explicit choice among multiple valid credentials", () => {
    const candidates = [
      setupCandidate(1, { sources: ["canonical"] }),
      setupCandidate(2, { sources: ["hermes"] }),
    ];
    const observation = setupObservation({
      canonical: {
        status: "active-valid",
        candidateSelectionId: "credential-1",
      },
      candidates,
    });

    expect(plan(observation)).toEqual({
      status: "selection-required",
      reason: "multiple-valid-credentials",
      candidates,
      invalidSources: [],
    });
    expect(
      plan(
        observation,
        setupDecision({ selectedCandidateId: "credential-1" }),
      ),
    ).toMatchObject({
      status: "resolved",
      disposition: "reuse",
      canonicalEffect: "unchanged",
    });
    expect(
      plan(
        observation,
        setupDecision({ selectedCandidateId: "credential-2" }),
      ),
    ).toMatchObject({
      status: "resolved",
      disposition: "replace",
      acquisition: "existing",
      canonicalEffect: "replace",
      reason: "different-credential-selected",
      credential: { selectionId: "credential-2" },
    });
  });

  it.each([
    [
      "no source exists",
      [] as const,
      "credential-not-found" as const,
    ],
    [
      "all noncanonical sources are invalid",
      ["environment", "hermes"] as const,
      "all-discovered-credentials-invalid" as const,
    ],
  ])(
    "requests registration input when %s",
    (_label, invalidSources, reason) => {
      const observation = setupObservation({ invalidSources });
      expect(plan(observation)).toEqual({
        status: "registration-input-required",
        reason,
        apiOrigin: DEFAULT_API_ORIGIN,
        canonicalEffect: "create",
        invalidSources: [...invalidSources],
      });

      expect(
        plan(
          observation,
          setupDecision({
            registration: {
              agentName: "Codex",
              username: "codex-agent",
            },
          }),
        ),
      ).toMatchObject({
        status: "resolved",
        disposition: "register",
        acquisition: "new-registration",
        canonicalEffect: "create",
        reason,
        registration: {
          mode: "new",
          agent: { name: "Codex", username: "codex-agent" },
        },
      });
    },
  );

  it.each([
    [
      "identity-mismatch",
      "canonical_identity_mismatch",
      "blocked",
      "credential-discovery-blocked",
    ],
    [
      "validation-unavailable",
      "credential_validation_unavailable",
      "unavailable",
      "credential-discovery-unavailable",
    ],
  ] as const)(
    "keeps pending %s evidence non-resumable",
    (resumeEvidence, blockerReason, category, reason) => {
      const result = plan(
        setupObservation({
          canonical: {
            status: "pending",
            apiOrigin: DEFAULT_API_ORIGIN,
            fingerprint: FINGERPRINT_A,
            agent: { name: "Codex", username: "codex-agent" },
            sources: ["canonical"],
            resumeEvidence,
          },
          blockers: [
            { reason: blockerReason, sources: ["canonical"] },
          ],
        }),
      );

      expect(result).toMatchObject({
        status: "blocked",
        category,
        reason,
      });
    },
  );

  it("makes invalid-canonical registration an explicit replacement", () => {
    const observation = setupObservation({
      canonical: { status: "active-invalid" },
      invalidSources: ["canonical"],
    });

    expect(plan(observation)).toEqual({
      status: "registration-input-required",
      reason: "canonical-credential-invalid",
      apiOrigin: DEFAULT_API_ORIGIN,
      canonicalEffect: "replace",
      invalidSources: ["canonical"],
    });
    expect(
      plan(
        observation,
        setupDecision({
          registration: {
            agentName: "Claude Code",
            username: "claude-agent",
          },
        }),
      ),
    ).toMatchObject({
      status: "resolved",
      disposition: "replace",
      acquisition: "new-registration",
      canonicalEffect: "replace",
      reason: "canonical-credential-invalid",
      registration: { mode: "new" },
    });
  });

  it.each([
    ["authenticated-match", "activate-existing"],
    ["definitively-inactive", "retry-registration"],
  ] as const)(
    "resumes an exact safe pending credential with %s evidence",
    (resumeEvidence, nextStep) => {
      const result = plan(
        setupObservation({
          canonical: {
            status: "pending",
            apiOrigin: DEFAULT_API_ORIGIN,
            fingerprint: FINGERPRINT_A,
            agent: { name: "Codex", username: "codex-agent" },
            sources: ["canonical", "environment"],
            resumeEvidence,
          },
          candidates: [setupCandidate(1, { sources: ["hermes"] })],
          invalidSources:
            resumeEvidence === "definitively-inactive"
              ? ["environment", "canonical"]
              : [],
        }),
      );

      expect(result).toMatchObject({
        status: "resolved",
        disposition: "register",
        acquisition: "resume-registration",
        canonicalEffect: "resume",
        reason: "canonical-registration-pending",
        registration: {
          mode: "resume",
          nextStep,
          fingerprint: FINGERPRINT_A,
          agent: { name: "Codex", username: "codex-agent" },
          sources: ["environment", "canonical"],
        },
      });
    },
  );

  it.each([
    [
      "a malformed source",
      "credential_source_malformed",
      "blocked",
      "credential-discovery-blocked",
    ],
    [
      "indeterminate validation",
      "credential_validation_unavailable",
      "unavailable",
      "credential-discovery-unavailable",
    ],
  ] as const)(
    "blocks safely for %s",
    (_label, blockerReason, category, reason) => {
      const result = plan(
        setupObservation({
          blockers: [
            { reason: blockerReason, sources: ["hermes"] },
          ],
        }),
      );
      expect(result).toMatchObject({
        status: "blocked",
        disposition: "blocked",
        category,
        reason,
        blockers: [
          { reason: blockerReason, sources: ["hermes"] },
        ],
      });
    },
  );

  it.each([
    [
      "recovery-required",
      "blocked",
      "credential-recovery-required",
    ],
    [
      "unavailable",
      "unavailable",
      "credential-recovery-unavailable",
    ],
  ] as const)(
    "never plans through %s transaction state",
    (transaction, category, reason) => {
      expect(
        plan(setupObservation({ transaction })),
      ).toMatchObject({
        status: "blocked",
        category,
        reason,
      });
    },
  );

  it("blocks every nonproduction credential origin", () => {
    const candidate = setupCandidate(1, {
      apiOrigin: OTHER_ORIGIN,
    });
    expect(
      plan(setupObservation({ candidates: [candidate] })),
    ).toMatchObject({
      status: "blocked",
      category: "blocked",
      reason: "credential-origin-mismatch",
      candidates: [{ apiOrigin: OTHER_ORIGIN }],
    });

    expect(
      plan(
        setupObservation({
          canonical: {
            status: "pending",
            apiOrigin: OTHER_ORIGIN,
            fingerprint: FINGERPRINT_A,
            agent: { name: "Codex", username: "codex-agent" },
            sources: ["canonical"],
            resumeEvidence: "definitively-inactive",
          },
          invalidSources: ["canonical"],
        }),
      ),
    ).toMatchObject({
      status: "blocked",
      reason: "credential-origin-mismatch",
    });
  });

  it("accepts protected input only as a validated, secret-free candidate", () => {
    const result = plan(
      setupObservation({
        candidates: [
          setupCandidate(1, { sources: ["protected-input"] }),
        ],
      }),
    );
    expect(result).toMatchObject({
      status: "resolved",
      disposition: "adopt",
      credential: { sources: ["protected-input"] },
    });
    expect(JSON.stringify(result)).not.toContain("apiKey");
  });

  it.each([
    ["without another credential", [] as const],
    [
      "instead of falling back to another credential",
      [setupCandidate(1, { sources: ["environment"] })],
    ],
  ])(
    "blocks invalid protected input %s",
    (_label, candidates) => {
      expect(
        plan(
          setupObservation({
            candidates,
            invalidSources: ["protected-input"],
          }),
        ),
      ).toMatchObject({
        status: "blocked",
        disposition: "blocked",
        category: "blocked",
        reason: "explicit-credential-invalid",
        invalidSources: ["protected-input"],
      });
    },
  );

  it("returns owned, deeply frozen data detached from the caller", () => {
    const candidate = setupCandidate(1, {
      sources: ["openclaw", "environment"],
    });
    const observation = setupObservation({ candidates: [candidate] });
    const result = plan(observation);

    (candidate.agent as { name: string }).name = "Changed";
    (candidate.sources as SetupCredentialSource[]).push("hermes");
    (observation.candidates as SetupCredentialCandidate[]).length = 0;

    expect(result).toMatchObject({
      credential: {
        agent: { name: "Codex" },
        sources: ["environment", "openclaw"],
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "resolved" || !("credential" in result)) {
      throw new Error("expected an existing-credential plan");
    }
    expect(Object.isFrozen(result.credential)).toBe(true);
    expect(Object.isFrozen(result.credential.agent)).toBe(true);
    expect(Object.isFrozen(result.credential.sources)).toBe(true);
    expect(Object.isFrozen(result.invalidSources)).toBe(true);
  });

  it("can enter the approval boundary as plain secret-free data", () => {
    const result = plan(
      setupObservation({
        candidates: [setupCandidate(1, { sources: ["hermes"] })],
      }),
    );
    const authority = createSetupApprovalAuthority();
    const prepared = authority.prepare(
      Object.freeze({ schemaVersion: 1, credential: result }),
    );
    const approval = authority.approve({
      plan: prepared,
      source: "interactive",
    });

    expect(JSON.stringify(prepared)).toContain(
      '"disposition":"adopt"',
    );
    expect(JSON.stringify(prepared)).not.toContain(CANARY);
    expect(authority.consume({ approval, plan: prepared })).toEqual({
      status: "approved",
      source: "interactive",
    });
  });

  it("rejects hidden secret state without reading or retaining it", () => {
    const candidate = setupCandidate(1) as SetupCredentialCandidate & {
      apiKey?: string;
    };
    Object.defineProperty(candidate, "apiKey", {
      configurable: false,
      enumerable: false,
      value: CANARY,
      writable: false,
    });
    try {
      plan(setupObservation({ candidates: [candidate] }));
      throw new Error("hidden secret unexpectedly entered the plan");
    } catch (error) {
      expect(error).toBeInstanceOf(SetupCredentialPlanError);
      expect(String(error)).toBe(
        `SetupCredentialPlanError: ${FIXED_ERROR}`,
      );
      expect(String(error)).not.toContain(CANARY);
    }
  });

  it.each([
    { status: "missing" },
    { status: "active-invalid" },
    { status: "unavailable" },
  ] as const)(
    "rejects hidden state on the $status canonical variant",
    (canonical) => {
      const value = { ...canonical } as Record<string, unknown>;
      Object.defineProperty(value, "apiKey", {
        configurable: false,
        enumerable: false,
        value: CANARY,
        writable: false,
      });
      expectFixedFailure({
        observation: {
          ...setupObservation(),
          canonical: value,
          ...(canonical.status === "active-invalid"
            ? { invalidSources: ["canonical"] }
            : {}),
          ...(canonical.status === "unavailable"
            ? {
                blockers: [
                  {
                    reason: "canonical_credential_unavailable",
                    sources: ["canonical"],
                  },
                ],
              }
            : {}),
        },
        decision: setupDecision(),
      });
    },
  );

  it("rejects a discriminant-changing Proxy", () => {
    let reads = 0;
    const canonical = new Proxy(
      { status: "missing" },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "status") {
            reads += 1;
            return {
              configurable: true,
              enumerable: true,
              value: reads === 1 ? "missing" : "active-invalid",
              writable: true,
            };
          }
          return Object.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    expectFixedFailure({
      observation: {
        ...setupObservation(),
        canonical,
      },
      decision: setupDecision(),
    });
  });

  it("rejects accessors without invoking them", () => {
    let reads = 0;
    const decision = Object.defineProperties({}, {
      selectedCandidateId: {
        enumerable: true,
        get() {
          reads += 1;
          return CANARY;
        },
      },
      registration: {
        enumerable: true,
        value: null,
      },
    });

    expectFixedFailure({
      observation: setupObservation(),
      decision,
    });
    expect(reads).toBe(0);
  });

  it("does not use Proxy get traps or retain caller proxies", () => {
    let reads = 0;
    const candidate = new Proxy(setupCandidate(1), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const result = plan(
      setupObservation({ candidates: [candidate] }),
    );
    expect(result).toMatchObject({
      status: "resolved",
      disposition: "adopt",
    });
    expect(reads).toBe(0);
    if (result.status !== "resolved" || !("credential" in result)) {
      throw new Error("expected an existing-credential plan");
    }
    expect(result.credential).not.toBe(candidate);
  });

  it("rejects unknown choices and registration mixed with candidates", () => {
    const observation = setupObservation({
      candidates: [setupCandidate(1)],
    });
    expect(() =>
      plan(
        observation,
        setupDecision({ selectedCandidateId: "credential-2" }),
      ),
    ).toThrow(FIXED_ERROR);
    expect(() =>
      plan(
        observation,
        setupDecision({
          registration: {
            agentName: "Codex",
            username: "codex-agent",
          },
        }),
      ),
    ).toThrow(FIXED_ERROR);
  });

  it.each([
    setupObservation({
      canonical: { status: "missing" },
      candidates: [setupCandidate(1, { sources: ["canonical"] })],
    }),
    setupObservation({
      canonical: { status: "active-invalid" },
      invalidSources: [],
    }),
    setupObservation({
      canonical: {
        status: "active-valid",
        candidateSelectionId: "credential-2",
      },
      candidates: [setupCandidate(1, { sources: ["canonical"] })],
    }),
    setupObservation({
      canonical: { status: "unavailable" },
    }),
    setupObservation({
      canonical: {
        status: "pending",
        apiOrigin: DEFAULT_API_ORIGIN,
        fingerprint: FINGERPRINT_A,
        agent: { name: "Codex", username: "codex-agent" },
        sources: ["environment"],
        resumeEvidence: "authenticated-match",
      },
    }),
  ])("rejects an inconsistent canonical observation", (observation) => {
    expect(() => plan(observation)).toThrow(FIXED_ERROR);
  });

  it.each([
    ["definitively-inactive", [] as const],
    ["authenticated-match", ["canonical"] as const],
  ] as const)(
    "rejects pending %s evidence with contradictory validity sources",
    (resumeEvidence, invalidSources) => {
      expect(() =>
        plan(
          setupObservation({
            canonical: {
              status: "pending",
              apiOrigin: DEFAULT_API_ORIGIN,
              fingerprint: FINGERPRINT_A,
              agent: { name: "Codex", username: "codex-agent" },
              sources: ["canonical"],
              resumeEvidence,
            },
            invalidSources,
          }),
        ),
      ).toThrow(FIXED_ERROR);
    },
  );

  it.each([
    [
      "duplicate selection IDs",
      [setupCandidate(1), setupCandidate(1, { fingerprint: FINGERPRINT_B })],
    ],
    [
      "duplicate public fingerprints",
      [setupCandidate(1), setupCandidate(2, { fingerprint: FINGERPRINT_A })],
    ],
    [
      "noncontiguous selection IDs",
      [setupCandidate(2)],
    ],
  ])("rejects %s", (_label, candidates) => {
    expect(() =>
      plan(setupObservation({ candidates })),
    ).toThrow(FIXED_ERROR);
  });

  it.each([
    [
      "one source assigned to two candidates",
      setupObservation({
        candidates: [
          setupCandidate(1, { sources: ["environment"] }),
          setupCandidate(2, { sources: ["environment"] }),
        ],
      }),
    ],
    [
      "one source both valid and invalid",
      setupObservation({
        candidates: [setupCandidate(1, { sources: ["hermes"] })],
        invalidSources: ["hermes"],
      }),
    ],
  ])("rejects contradictory evidence with %s", (_label, observation) => {
    expect(() => plan(observation)).toThrow(FIXED_ERROR);
  });

  it("preserves an attested fingerprint collision as a blocked plan", () => {
    const candidates = [
      setupCandidate(1, { sources: ["environment"] }),
      setupCandidate(2, {
        fingerprint: FINGERPRINT_A,
        sources: ["hermes"],
      }),
    ];
    expect(
      plan(
        setupObservation({
          candidates,
          blockers: [
            {
              reason: "credential_fingerprint_collision",
              sources: ["environment", "hermes"],
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: "blocked",
      category: "blocked",
      reason: "credential-discovery-blocked",
      candidates: [
        { fingerprint: FINGERPRINT_A },
        { fingerprint: FINGERPRINT_A },
      ],
    });
  });

  it.each([
    ["secret-bearing name", { name: CANARY }],
    ["unsafe username", { username: "Agent Name" }],
    ["invalid agent ID", { id: "not-an-agent-id" }],
    [
      "invalid fingerprint",
      { fingerprint: "plurum-fp-v1:TOO-SHORT" },
    ],
  ])("rejects a candidate with %s", (_label, override) => {
    const candidateOverride = override as Partial<{
      readonly fingerprint: string;
      readonly id: string;
      readonly name: string;
      readonly username: string;
    }>;
    const malformed = {
      ...setupCandidate(1),
      ...(candidateOverride.fingerprint === undefined
        ? {}
        : { fingerprint: candidateOverride.fingerprint }),
      agent: {
        ...setupCandidate(1).agent,
        ...(candidateOverride.name === undefined
          ? {}
          : { name: candidateOverride.name }),
        ...(candidateOverride.username === undefined
          ? {}
          : { username: candidateOverride.username }),
        ...(candidateOverride.id === undefined
          ? {}
          : { id: candidateOverride.id }),
      },
    };
    expectFixedFailure({
      observation: setupObservation({
        candidates: [
          malformed as unknown as SetupCredentialCandidate,
        ],
      }),
      decision: setupDecision(),
    });
  });

  it("rejects extra, symbol, and revoked state with one diagnostic", () => {
    expectFixedFailure({
      observation: setupObservation(),
      decision: setupDecision(),
      apiKey: CANARY,
    });

    const symbolObservation = setupObservation() as
      SetupCredentialPlanningObservation & Record<symbol, string>;
    symbolObservation[Symbol("secret")] = CANARY;
    expectFixedFailure({
      observation: symbolObservation,
      decision: setupDecision(),
    });

    const { proxy, revoke } = Proxy.revocable(
      setupObservation(),
      {},
    );
    revoke();
    expectFixedFailure({ observation: proxy, decision: setupDecision() });
  });
});
