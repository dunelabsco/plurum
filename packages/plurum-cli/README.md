# Plurum CLI

The Plurum CLI will provide one safe onboarding command for connecting Claude
Code and Codex to Plurum's hosted collective-intelligence tools.

## Development status

This package is private throughout Phase 4 and cannot be published accidentally.
`plurum setup --dry-run` now performs a secret-free host preflight and prints
the exact future credential destinations and reversible host commands without
reading credentials or changing state. Setup apply, status, and doctor remain
unavailable and return an explicit nonzero result instead of pretending that
registration or host configuration succeeded.
The apply grammar now reserves `--yes` for approval of one exact displayed
plan. `--yes` is invalid with `--dry-run`, and `--api-key-stdin` requires
`--yes` so confirmation and credential input can never compete for stdin.
While apply is unavailable, neither flag causes stdin to be read or grants
mutation authority. A pure, unwired apply-plan composer now combines one
resolved credential decision, the exact retained host preflight, and—when
Codex is executable—an exact secret-free user-`.env` projection decision. It
prepares one immutable approval-bound plan and renders only its public preview,
including the disclosure that Codex and processes it starts may inherit the
API key. The command does not use that composer yet.

The completed CLI will expose only:

```text
plurum setup
plurum status
plurum doctor
```

`setup` will perform the complete recoverable onboarding flow. `status` and
`doctor` will remain read-only. The CLI will not install a local MCP runtime.

## Safety boundary

Filesystem, network, process, clock, randomness, fixed cryptographic hashing,
and platform access enter commands only through injected capabilities.
Production filesystem, network, process, and host adapters remain
deny-by-default until their implementation steps.
The canonical credential schema, protected read port, and transactional
write/recovery state machine are implemented as portable, injected cores. A
native semantic bridge and platform adapters now exercise those cores in
isolated tests. They remain deliberately unwired from commands: the package has
no native artifact resolver or runtime import, so no command can access a real
credential path.
Portable read-only command code cannot mutate local or product state or use the
generic process capability. Native host inspection remains a separate,
narrowly bounded semantic capability that may perform only each host's fixed
read operations. Status and doctor are restricted to GET requests; any later
protocol-level MCP diagnostic will require its own narrowly defined capability.
Dry-run setup resolves credential destination names and uses only semantic host
inspection. It cannot directly read arbitrary file contents, credential
sources, stdin, authenticated network state, randomness, or host-mutation
capabilities.
The unavailable apply path receives only semantic inspection sourced from the
future mutation authority. The command is not given raw stdin, filesystem,
network, credential-environment, process, randomness, hashing, or host-mutation
capabilities. A separate opaque approval core first creates an owned canonical
deeply frozen plan, then binds one approval use to that exact snapshot. Caller
objects, accessors, and proxies cannot survive into the approved plan. The core
is not wired to a prompt or executor. A separate pure planner now defines the
secret-free credential dispositions that the eventual plan must show: reuse,
adopt, register, replace, or block. Selection and registration-input states are
explicitly non-approvable. This planner has no credential reader, secret,
network, prompt, registration, filesystem, or mutation capability; execution
remains gated on an exact compare-and-swap observation of canonical credential
and recovery state. The apply-plan composer rejects unresolved credentials and
blocked host preflights. Its projection planner distinguishes create,
unchanged, replace, ambiguous, unsafe, and unavailable Codex states relative
to the exact selected credential without receiving a key. Complete host
reconciliation evidence stays outside the rendered preview, and composition
cannot re-inspect hosts or perform changes. It remains unreachable from the CLI
until native projection and credential observation, confirmation, secret
input, and persistence boundaries are wired.

The test harness refuses unverifiable execution and unsafe identity changes,
confines guarded fake operations to a unique private root, rejects lexical,
canonical, symlink/reparse-point, and hard-link escapes, and never uses real
credentials, host binaries, or production endpoints. On POSIX it also refuses
effective-user changes and privileged execution; on Windows it refuses thread
impersonation and binds access to the process token's exact user SID. An AST
gate rejects direct capability imports or globals outside the small approved
adapter boundary. Native filesystem access remains unavailable to production.

A separate POSIX disk harness now runs the credential reader and transactional
writer against real files inside that sentinel-backed root. It verifies private
modes, ownership, no-follow and exclusive opens, replacement, cleanup, and
ordinary file/directory flush ordering. The harness is excluded from `dist` and
does not claim production locking, crash abandonment, directory-relative
syscalls, macOS ACL/full-flush guarantees, or safety outside the controlled test
root.

The production build contains a lazy semantic boundary for the native
credential adapter. It accepts only one exact, versioned Plurum ABI and exposes
only the existing high-level read and transactional-mutation ports through
frozen, lease-scoped capabilities. The boundary is intentionally unwired and
has no binary, native dependency, package resolver, JavaScript fallback, or
command/runtime import.

The repository contains an unpublished Rust `cdylib` that establishes this
boundary's Node-API 8 descriptor and semantic adapter factory on native CI
runners. Staged ABI tests load that factory and drive the portable reader,
writer, and recovery cores end to end with a fake credential. The crate is
excluded from the npm package, and no compiled native artifact is retained or
published.

The crate contains private macOS/Linux directory, bounded-read, kernel-lease,
and transactional-mutation primitives. Native tests exercise
component-by-component no-follow traversal, retained identity binding,
owner/mode/link and exact macOS ACL checks, content-sensitive revisions,
exclusive fixed-name candidates, exact write readback, conditional
descriptor-relative rename/removal, bounded recovery enumeration, adversarial
replacement, live contention, and process-death abandonment inside the
sentinel-backed runner root. Linux uses ordinary file and directory flushes;
macOS adds `F_FULLFSYNC` for sensitive files and the lock.

The Windows adapter binds retained handles to a local fixed NTFS volume, the
current process user SID, an exact protected user-only DACL, non-reparse
objects, and stable file identities. It uses a persistent kernel lock,
same-directory exclusive candidates, handle-relative atomic replacement and
removal, flushed files, bounded recovery enumeration, and post-operation
reattestation. It accepts only an exact medium-integrity process token and fails
closed under impersonation, high integrity, low integrity, or other integrity
levels; users in a high-integrity terminal must rerun the CLI normally.
Windows has no documented general directory-flush primitive, so its namespace
barrier covers completed operations and process crashes but does not claim
physical power-loss durability.

Native artifact resolution/packaging and mutating command wiring remain
activation blockers.
The foundation matrix executes current macOS arm64/x64, Linux glibc arm64/x64,
and Windows x64 runners, including the declared Rust 1.88 minimum. Older
macOS/Linux floors, Linux musl, and Windows arm64 remain unvalidated release
targets.

The completed apply flow will accept API keys only through protected
interactive input or explicit `--api-key-stdin --yes`. A value-bearing
`--api-key` option does not exist, and invalid arguments are never reflected in
diagnostics.

## Development

Use Node.js 22.12 or newer in the Node 22 LTS line, or Node.js 24 LTS:

```bash
npm ci
npm run check
npm pack --dry-run
```

Generated `dist/` output is intentionally not committed.

## Exit status

- `0` — success
- `1` — operational failure
- `2` — invalid command usage
- `3` — command unavailable in the private development build
