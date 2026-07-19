# Plurum CLI

The Plurum CLI will provide one safe onboarding command for connecting Claude
Code and Codex to Plurum's hosted collective-intelligence tools.

## Development status

This package is private throughout Phase 4 and cannot be published accidentally.
The command surface is scaffolded, but unfinished commands return an explicit
nonzero result instead of pretending that registration or host configuration
succeeded.

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
Production filesystem, network, and process adapters remain deny-by-default
until their implementation steps.
The canonical credential schema, protected read port, and transactional
write/recovery state machine are implemented as portable, injected cores. They
remain deliberately unwired: no command can access a real credential path until
the native POSIX and Windows ownership, permission/ACL, link, lease, atomic
replacement, and durability adapters pass their isolated platform suites.
Read-only commands cannot mutate local or product state or spawn. Status and
doctor are restricted to GET requests; any later protocol-level MCP diagnostic
will require its own narrowly defined capability. Dry-run setup cannot read file
contents, stdin, or authenticated network state.

The test harness refuses elevated or unverifiable execution, confines guarded
fake operations to a unique private root, rejects lexical, canonical, ordinary
symlink, and hard-link escapes, and never uses real credentials, host binaries,
or production endpoints. An AST gate rejects direct capability imports or
globals outside the small approved adapter boundary. Native filesystem access
remains unavailable to production until the complete platform suites pass.

A separate POSIX disk harness now runs the credential reader and transactional
writer against real files inside that sentinel-backed root. It verifies private
modes, ownership, no-follow and exclusive opens, replacement, cleanup, and
ordinary file/directory flush ordering. The harness is excluded from `dist` and
does not claim production locking, crash abandonment, directory-relative
syscalls, macOS ACL/full-flush guarantees, or safety outside the controlled test
root.

The production build also contains a lazy semantic boundary for a future native
credential adapter. It accepts only one exact, versioned Plurum ABI and exposes
only the existing high-level read and transactional-mutation ports. The
boundary is intentionally unwired and has no binary, native dependency,
package resolver, JavaScript fallback, or command/runtime import. Loading and
platform access remain unavailable until the native macOS, Linux, and Windows
suites establish their guarantees independently.

The repository contains an unpublished Rust `cdylib` that establishes this
boundary's Node-API 8 descriptor on native CI runners. Its adapter factory
returns no value, so the TypeScript provider remains unavailable even when the
test binary is loaded. The crate is excluded from the npm package, and no
compiled native artifact is retained or published.
The crate also contains private macOS/Linux directory, bounded-read, and
kernel-lease primitives. Native tests exercise component-by-component
no-follow traversal, retained identity binding, owner/mode/link checks,
content-sensitive revisions, live contention, and process-death abandonment
inside the sentinel-backed runner root. These primitives are not exported to
JavaScript; POSIX mutation/durability, macOS ACL/full-flush, and Windows
security remain activation blockers.
The foundation matrix executes current macOS arm64/x64, Linux glibc arm64/x64,
and Windows x64 runners. Oldest-supported macOS and Linux kernel/glibc floors,
Linux musl, and Windows arm64 remain unvalidated release blockers.

API keys are accepted only through protected interactive input or
`--api-key-stdin`. A value-bearing `--api-key` option does not exist, and invalid
arguments are never reflected in diagnostics.

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
