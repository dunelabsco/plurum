import type {
  ReconciliationJournalLease,
  ReconciliationJournalRevisionSnapshot,
  ReconciliationJournalStoreAdapter,
} from "../../src/hosts/journal-contracts.js";

export interface InMemoryReconciliationJournalOptions {
  readonly busyAtAcquire?: number;
  readonly throwAtAcquire?: number;
  readonly replaceConflictAt?: number;
}

export function createInMemoryReconciliationJournal(
  options: InMemoryReconciliationJournalOptions = {},
) {
  let bytes: Uint8Array | undefined;
  let revision = 0;
  let active = false;
  let acquireCalls = 0;
  let replaceCalls = 0;
  let removeCalls = 0;
  let releaseCalls = 0;
  let abandonCalls = 0;
  const writes: Uint8Array[] = [];

  function token(): ReconciliationJournalRevisionSnapshot {
    return Object.freeze({ revision }) as unknown as
      ReconciliationJournalRevisionSnapshot;
  }

  function matches(value: ReconciliationJournalRevisionSnapshot): boolean {
    return (
      value as unknown as Readonly<{ readonly revision?: unknown }>
    ).revision === revision;
  }

  const store: ReconciliationJournalStoreAdapter = Object.freeze({
    async acquire() {
      acquireCalls += 1;
      if (options.throwAtAcquire === acquireCalls) {
        throw new Error("simulated reconciliation journal failure");
      }
      if (
        active ||
        options.busyAtAcquire === acquireCalls
      ) {
        return Object.freeze({ status: "busy" as const });
      }
      active = true;
      const lease: ReconciliationJournalLease =
        Object.freeze<ReconciliationJournalLease>({
        async renew() {
          if (!active) {
            throw new Error("inactive in-memory reconciliation lease");
          }
          return Object.freeze({ status: "held" as const });
        },
        async observe() {
          if (!active) {
            throw new Error("inactive in-memory reconciliation lease");
          }
          if (bytes === undefined) {
            return Object.freeze({
              status: "missing" as const,
              revision: token(),
            });
          }
          const copied = bytes.slice();
          return Object.freeze({
            status: "present" as const,
            revision: token(),
            bytes: copied,
          });
        },
        async replace(request) {
          if (!active) {
            throw new Error("inactive in-memory reconciliation lease");
          }
          replaceCalls += 1;
          if (
            options.replaceConflictAt === replaceCalls ||
            !matches(request.expected)
          ) {
            return Object.freeze({ status: "conflict" as const });
          }
          bytes?.fill(0);
          bytes = request.bytes.slice();
          writes.push(bytes.slice());
          revision += 1;
          return Object.freeze({
            status: "replaced" as const,
            revision: token(),
          });
        },
        async remove(request) {
          if (!active) {
            throw new Error("inactive in-memory reconciliation lease");
          }
          removeCalls += 1;
          if (bytes === undefined || !matches(request.expected)) {
            return Object.freeze({ status: "conflict" as const });
          }
          bytes.fill(0);
          bytes = undefined;
          revision += 1;
          return Object.freeze({ status: "removed" as const });
        },
        async release() {
          if (!active) {
            throw new Error("inactive in-memory reconciliation lease");
          }
          releaseCalls += 1;
          active = false;
        },
        async abandon() {
          if (!active) {
            throw new Error("inactive in-memory reconciliation lease");
          }
          abandonCalls += 1;
          active = false;
        },
        });
      return Object.freeze({
        status: "acquired" as const,
        priorLease: "absent" as const,
        lease,
      });
    },
  });

  return Object.freeze({
    store,
    control: Object.freeze({
      acquireCalls: () => acquireCalls,
      replaceCalls: () => replaceCalls,
      removeCalls: () => removeCalls,
      releaseCalls: () => releaseCalls,
      abandonCalls: () => abandonCalls,
      hasJournal: () => bytes !== undefined,
      writes: () => Object.freeze(writes.map((entry) => entry.slice())),
    }),
  });
}
