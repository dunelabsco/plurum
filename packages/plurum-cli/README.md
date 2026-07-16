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

The scaffold performs no filesystem mutation, network request, host detection,
or child-process execution. Those capabilities will be introduced behind
injected adapters and tested inside a fail-closed temporary root before they can
be used by a command.

API keys are accepted only through protected interactive input or
`--api-key-stdin`. A value-bearing `--api-key` option does not exist, and invalid
arguments are never reflected in diagnostics.

## Development

Use Node.js 22 LTS or Node.js 24 LTS:

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
