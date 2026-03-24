# Overstory DevContainer

Development environment for the `overstory` multi-agent swarm CLI. Runs inside a Docker container with Bun, tmux, and the full os-eco tool ecosystem pre-installed.

## Prerequisites

- Docker Desktop (or compatible Docker runtime)
- A DevContainer-compatible IDE: VS Code with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers), JetBrains Gateway, or GitHub Codespaces
- At least one LLM API key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) set in your host environment

## Quick Start

### VS Code

1. Open the `overstory/` folder in VS Code
2. When prompted, click "Reopen in Container" (or run `Dev Containers: Reopen in Container` from the command palette)
3. Wait for `postCreateCommand` to finish — it installs ecosystem CLIs and generates `config.local.yaml`
4. Run `ov doctor` to confirm everything is healthy

### GitHub Codespaces

Click "Code" on the repo, select "Codespaces", then "Create codespace on main". Setup runs automatically.

### JetBrains Gateway

Connect to the repo via Gateway and select the `.devcontainer/devcontainer.json` configuration when prompted.

## What's Installed

The container image provides:

| Tool | Version | Notes |
|------|---------|-------|
| Bun | 1.3.11+ | Runtime and package manager |
| git | 2.39.5+ | Required for worktree operations |
| tmux | 3.3a+ | Agent session isolation |
| curl, jq | latest | Utility tools |

`postCreateCommand` installs these globally via `bun install -g`:

| Binary | Package | Purpose |
|--------|---------|---------|
| `opencode` | `opencode-ai` | Default agent runtime |
| `sd` | `@os-eco/seeds-cli` | Git-native issue tracking |
| `cn` | `@os-eco/canopy-cli` | Prompt management |
| `bd` | `@os-eco/beads-cli` | Alternative issue tracker |
| `mulch` | `@os-eco/mulch-cli` | Structured expertise client |

`mulch` is also a runtime dep in `package.json` and is available after `bun install + bun link`. The script skips the global install if it's already on `PATH`.

## Environment Variables

Variables are forwarded from your host environment at container attach time using the `${localEnv:VAR}` mechanism in `devcontainer.json`. Set them on your host before opening the container.

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Required for Claude | Passed to the OpenCode runtime and agent sessions |
| `OPENAI_API_KEY` | Required for OpenAI | Passed to the OpenCode runtime and agent sessions |
| `OPENCODE_MODEL` | Optional | Override the default model (e.g. `claude-sonnet-4-5`) |
| `OPENCODE_PROVIDER` | Optional | Override the default provider |

If a variable isn't set on the host, it won't be forwarded — the container won't error, but the runtime will fail when it tries to make API calls.

**Never put API keys in `devcontainer.json` or any committed file.**

## Configuration

`post-create.sh` generates `.overstory/config.local.yaml` (gitignored) with container-specific overrides:

```yaml
project:
  root: /workspaces/overstory
runtime:
  default: opencode
```

This file is deep-merged on top of `config.yaml` at runtime. You can add further overrides here without touching the committed config. Common things to override:

- `runtime.default` — switch to a different adapter (e.g. `claude`, `codex`)
- `project.root` — should stay as `/workspaces/overstory` inside the container

To reset to defaults, delete `.overstory/config.local.yaml` and re-run `bash .devcontainer/post-create.sh`.

## Known Limitations

- **tmux sessions don't survive container restarts.** Any running agent sessions are lost when the container stops. Worktrees and branches persist (they're in the git repo), but you'll need to reattach or re-sling agents after a restart.

- **OpenCode adapter is experimental.** The `opencode` runtime has `stability: "experimental"`. The `detectReady` and `parseTranscript` methods are stubbed, so agents spawned via OpenCode will show "loading" permanently in `ov status`. They do run — the status display is just unreliable.

- **`bd` (beads) may fail on some platforms.** The `@os-eco/beads-cli` package has CGO/Dolt dependencies that don't build cleanly on all architectures. If `bd` fails, use `sd` (seeds) instead — both back the same tracker interface.

- **Git worktrees created inside the container are lost on rebuild.** `ov sling` creates worktrees under the workspace. A full container rebuild (not just restart) wipes them. Commit and push any agent branches before rebuilding.

## Troubleshooting

**`ov doctor` reports a missing tool**

Run `ov doctor` to see exactly which check failed. Re-install the missing binary:

```bash
bun install -g opencode-ai        # opencode
bun install -g @os-eco/seeds-cli  # sd
bun install -g @os-eco/canopy-cli # cn
bun install -g @os-eco/beads-cli  # bd
bun install -g @os-eco/mulch-cli  # mulch
```

Note: `ov doctor` does not check `opencode` — verify it separately with `which opencode`.

**API key not forwarded into the container**

Check that the variable is exported on your host before opening the container:

```bash
echo $ANTHROPIC_API_KEY  # should print your key
```

If it's empty, set it in your shell profile (`~/.zshrc`, `~/.bashrc`, etc.), then rebuild the container.

**`bun install` fails with lockfile errors**

```bash
bun install --no-frozen-lockfile
```

**`opencode` not found after setup**

The global install may have failed silently. Re-run manually:

```bash
bun install -g opencode-ai
which opencode
```

**`ov sling` fails immediately**

Check that tmux is running and the workspace path is correct in `config.local.yaml`. The `project.root` must be `/workspaces/overstory` inside the container.

## For Contributors

The full quality gate before pushing:

```bash
bun test && biome check . && tsc --noEmit
```

Individual steps:

```bash
bun test          # run tests
biome check .     # lint + format check
tsc --noEmit      # typecheck
```

Tests are colocated with source (`{module}.test.ts`). Prefer real implementations over mocks — `mock.module()` leaks across test files.

Work is not complete until `git push` succeeds. The session completion protocol enforces this.
