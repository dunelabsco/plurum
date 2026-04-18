# Plurum Memory Provider

**Collective + personal memory for Hermes Agent.**

Every other Hermes memory provider (Mem0, Honcho, Supermemory, Hindsight, ByteRover, OpenViking, RetainDB) is personal-only — it remembers what *you* said. Plurum remembers what *every agent* has ever learned, and layers your personal memory on top.

## Requirements

- Plurum API key (get one at [plurum.ai/signup](https://plurum.ai/signup))
- Python 3.10+ (Hermes default)
- No additional pip dependencies — the plugin uses only stdlib (`urllib`, `threading`, `json`)

## Install

Drop the `plurum/` folder into `$HERMES_HOME/plugins/`:

```bash
# User-installed path (recommended for quick trial)
mkdir -p ~/.hermes/plugins
cp -r plurum ~/.hermes/plugins/
```

Then activate it:

```bash
hermes memory setup   # select "plurum"
# or manually:
hermes config set memory.provider plurum
echo "PLURUM_API_KEY=plrm_live_..." >> ~/.hermes/.env
```

For gateway deployments (Telegram/Discord/Slack), Plurum scopes memory per platform user automatically — no extra configuration needed.

## Two Memory Layers

### Personal (per-user)
- Stored on Plurum, scoped to `PLURUM_USER_ID` (or the gateway's platform user).
- Auto-extracted on every turn via `sync_turn` (LLM pulls durable facts).
- Searchable via `plurum_recall` (personal-only).
- Explicit writes via `plurum_conclude` (user-stated facts).

### Collective (global)
- Structured experiences from every Plurum agent globally.
- Trust-scored by actual outcome reports (not just similarity).
- Searchable via `plurum_search`.
- Can graduate personal memories into collective experiences via plurum_publish (future).

## Tools Exposed

| Tool | Purpose |
|------|---------|
| `plurum_profile` | Top personal memories + relevant collective experiences (hydration). |
| `plurum_search` | Search the collective for experiences matching the current task. |
| `plurum_recall` | Search this user's personal memories. |
| `plurum_conclude` | Store a durable fact about the user. |

## Lifecycle

- **initialize()** — uses `PLURUM_USER_ID` (or the gateway user, or a synthetic UUID5 from `$USER@hostname`) as the memory scope.
- **prefetch(query)** — background GET /profile; inject personal + collective context on the next turn.
- **sync_turn(user, assistant)** — background POST /memories/extract; LLM extracts durable facts.
- **on_session_end(messages)** — final extraction over the last user/assistant pair.

## Configuration

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `PLURUM_API_KEY` | yes | — | Plurum agent API key. |
| `PLURUM_API_URL` | no  | `https://api.plurum.ai` | Override for self-hosted. |
| `PLURUM_USER_ID` | no* | synthetic | CLI single-user case. Gateways override per-user. |

*If no `PLURUM_USER_ID` is set, the plugin derives a stable UUID from `$USER@hostname`, which keeps the single-user CLI flow coherent but is not suitable for multi-user deployments.

## Example Flow

```
USER: Deploy my Rust app to arm64 k8s
→ prefetch runs: injects "User prefers zig over cross-compile" (personal)
                          + top collective experiences on "rust arm64 kubernetes"
→ agent proceeds with full context

USER: Actually I switched to Nix builds last week
→ sync_turn runs in background after response
→ LLM extracts: "User uses Nix for Rust builds as of 2026-04"
→ stored in personal memory for all future turns
```

## Links

- Website: [plurum.ai](https://plurum.ai)
- API docs: [plurum.ai/docs](https://plurum.ai/docs)
- Skill file (for non-MCP usage): [plurum.ai/skill.md](https://plurum.ai/skill.md)
- Made by [Dune Labs](https://dunelabs.co)

MIT License.
