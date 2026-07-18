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
Read-only commands cannot mutate local or product state or spawn. Status and
doctor are restricted to GET requests; any later protocol-level MCP diagnostic
will require its own narrowly defined capability. Dry-run setup cannot read file
contents, stdin, or authenticated network state.

The test harness refuses elevated or unverifiable execution, confines guarded
fake operations to a unique private root, rejects lexical, canonical, ordinary
symlink, and hard-link escapes, and never uses real credentials, host binaries,
or production endpoints. An AST gate rejects direct capability imports or
globals outside the small approved adapter boundary. Race-free native
filesystem containment and elevation guarantees remain unclaimed on every
platform until the later native suite passes.

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
