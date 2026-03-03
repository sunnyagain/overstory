// Sapling runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `sp` CLI (Sapling headless coding agent).
//
// Key characteristics:
// - Headless: Sapling runs as a Bun subprocess (no tmux TUI)
// - Instruction file: SAPLING.md (auto-read from worktree root)
// - Communication: JSON-RPC over stdin/stdout (--mode rpc)
// - Guards: .sapling/guards.json (written by deployConfig from guard-rules.ts constants)
// - Events: NDJSON stream on stdout (parsed for token usage and agent events)

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	DANGEROUS_BASH_PATTERNS,
	INTERACTIVE_TOOLS,
	NATIVE_TEAM_TOOLS,
	SAFE_BASH_PREFIXES,
	WRITE_TOOLS,
} from "../agents/guard-rules.ts";
import { DEFAULT_QUALITY_GATES } from "../config.ts";
import type { ResolvedModel } from "../types.ts";
import type {
	AgentEvent,
	AgentRuntime,
	DirectSpawnOpts,
	HooksDef,
	OverlayContent,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * Bash patterns that modify files and require path boundary validation
 * for implementation agents (builder/merger). Mirrors the constant in pi-guards.ts.
 */
const FILE_MODIFYING_BASH_PATTERNS = [
	"sed\\s+-i",
	"sed\\s+--in-place",
	"echo\\s+.*>",
	"printf\\s+.*>",
	"cat\\s+.*>",
	"tee\\s",
	"\\bmv\\s",
	"\\bcp\\s",
	"\\brm\\s",
	"\\bmkdir\\s",
	"\\btouch\\s",
	"\\bchmod\\s",
	"\\bchown\\s",
	">>",
	"\\binstall\\s",
	"\\brsync\\s",
];

/** Capabilities that must not modify project files (read-only mode). */
const NON_IMPLEMENTATION_CAPABILITIES = new Set([
	"scout",
	"reviewer",
	"lead",
	"coordinator",
	"supervisor",
	"monitor",
]);

/** Coordination capabilities that get git add/commit whitelisted for metadata sync. */
const COORDINATION_CAPABILITIES = new Set(["coordinator", "supervisor", "monitor"]);

/**
 * Build the full guards configuration object for .sapling/guards.json.
 *
 * Translates overstory guard-rules.ts constants and HooksDef fields into a
 * JSON-serializable format that the `sp` CLI can consume to enforce:
 * - Path boundary: all writes must target files within worktreePath.
 * - Blocked tools: NATIVE_TEAM_TOOLS and INTERACTIVE_TOOLS for all agents;
 *   WRITE_TOOLS additionally for non-implementation capabilities.
 * - Bash guards: DANGEROUS_BASH_PATTERNS blocklist (non-impl) or
 *   FILE_MODIFYING_BASH_PATTERNS path boundary (impl), with SAFE_BASH_PREFIXES.
 * - Quality gates: commands agents must pass before reporting completion.
 * - Event config: argv arrays for activity tracking via `ov log`.
 *
 * @param hooks - Agent identity, capability, worktree path, and optional quality gates.
 * @returns JSON-serializable guards configuration object.
 */
function buildGuardsConfig(hooks: HooksDef): Record<string, unknown> {
	const { agentName, capability, worktreePath, qualityGates } = hooks;
	const gates = qualityGates ?? DEFAULT_QUALITY_GATES;
	const isNonImpl = NON_IMPLEMENTATION_CAPABILITIES.has(capability);
	const isCoordination = COORDINATION_CAPABILITIES.has(capability);

	// Build safe Bash prefixes: base set + coordination extras + quality gate commands.
	const safePrefixes: string[] = [
		...SAFE_BASH_PREFIXES,
		...(isCoordination ? ["git add", "git commit"] : []),
		...gates.map((g) => g.command),
	];

	return {
		// Schema version for forward-compatibility.
		version: 1,
		// Agent identity (injected into event tracking commands).
		agentName,
		capability,
		// Path boundary: all file writes must target paths within this directory.
		// Equivalent to the worktree's exclusive file scope.
		pathBoundary: worktreePath,
		// Read-only mode: true for non-implementation capabilities (scout, reviewer, lead, etc.).
		// When true, write tools are blocked in addition to the always-blocked tool set.
		readOnly: isNonImpl,
		// Tool names blocked for ALL agents.
		// - nativeTeamTools: use `ov sling` for delegation instead.
		// - interactiveTools: escalate via `ov mail --type question` instead.
		blockedTools: [...NATIVE_TEAM_TOOLS, ...INTERACTIVE_TOOLS],
		// Tool names blocked only for read-only (non-implementation) agents.
		// Empty array for implementation agents (builder/merger).
		writeToolsBlocked: isNonImpl ? [...WRITE_TOOLS] : [],
		// Write/edit tool names subject to path boundary enforcement (all agents).
		writeToolNames: [...WRITE_TOOLS],
		bashGuards: {
			// Safe Bash prefixes: bypass dangerous pattern checks when matched.
			// Includes base overstory commands, optional git add/commit for coordination,
			// and quality gate command prefixes.
			safePrefixes,
			// Dangerous Bash patterns: blocked for non-implementation agents.
			// Each string is a regex fragment (grep -qE compatible).
			dangerousPatterns: DANGEROUS_BASH_PATTERNS,
			// File-modifying Bash patterns: require path boundary check for implementation agents.
			// Each string is a regex fragment; matched paths must fall within pathBoundary.
			fileModifyingPatterns: FILE_MODIFYING_BASH_PATTERNS,
		},
		// Quality gate commands that must pass before the agent reports task completion.
		qualityGates: gates.map((g) => ({
			name: g.name,
			command: g.command,
			description: g.description,
		})),
		// Activity tracking event configuration.
		// Each value is an argv array passed to Bun.spawn() — no shell interpolation.
		// The `sp` runtime fires these on the corresponding lifecycle events.
		eventConfig: {
			// Fires before each tool executes (updates lastActivity in SessionStore).
			onToolStart: ["ov", "log", "tool-start", "--agent", agentName],
			// Fires after each tool completes.
			onToolEnd: ["ov", "log", "tool-end", "--agent", agentName],
			// Fires when the agent's work loop completes or the process exits.
			onSessionEnd: ["ov", "log", "session-end", "--agent", agentName],
		},
	};
}

/**
 * Sapling runtime adapter.
 *
 * Implements AgentRuntime for the `sp` CLI (Sapling headless coding agent).
 * Sapling workers run as headless Bun subprocesses — they communicate via
 * JSON-RPC on stdin/stdout rather than a TUI in a tmux pane. This means
 * all tmux lifecycle methods (buildSpawnCommand, detectReady, requiresBeaconVerification)
 * are stubs: the orchestrator checks `runtime.headless === true` and takes the
 * direct-spawn code path instead.
 *
 * Instructions are delivered via `SAPLING.md` in the worktree root.
 * Guard configuration is written to `.sapling/guards.json` (stub for Wave 3).
 *
 * Hardware impact: Sapling workers use 60–120 MB RAM vs 250–400 MB for TUI agents,
 * enabling 4–6× more concurrent workers on a typical developer machine.
 */
export class SaplingRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "sapling";

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = "SAPLING.md";

	/**
	 * Whether this runtime is headless (no tmux, direct subprocess).
	 * Headless runtimes bypass all tmux session management and use Bun.spawn directly.
	 */
	readonly headless = true;

	/**
	 * Build the shell command string to spawn a Sapling agent in a tmux pane.
	 *
	 * This method exists for the TUI fallback path (e.g., `ov sling --runtime sapling`
	 * on a host that has tmux). Under normal operation, Sapling is headless and
	 * buildDirectSpawn() is used instead.
	 *
	 * Maps SpawnOpts to `sp run` flags:
	 * - `model` → `--model <model>`
	 * - `appendSystemPromptFile` → prepended via `$(cat ...)` shell expansion
	 * - `appendSystemPrompt` → appended inline
	 * - `permissionMode` is accepted but NOT mapped — Sapling enforces security
	 *   via .sapling/guards.json rather than permission flags.
	 *
	 * @param opts - Spawn options (model, appendSystemPrompt; permissionMode ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `sp run --model ${opts.model} --mode rpc`;

		if (opts.appendSystemPromptFile) {
			// Read role definition from file at shell expansion time — avoids tmux
			// IPC message size limits. Append the "read SAPLING.md" instruction.
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` "$(cat '${escaped}')"' Read SAPLING.md for your task assignment and begin immediately.'`;
		} else if (opts.appendSystemPrompt) {
			// Inline role definition + instruction to read SAPLING.md.
			const prompt = `${opts.appendSystemPrompt}\n\nRead SAPLING.md for your task assignment and begin immediately.`;
			const escaped = prompt.replace(/'/g, "'\\''");
			cmd += ` '${escaped}'`;
		} else {
			cmd += ` 'Read SAPLING.md for your task assignment and begin immediately.'`;
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Sapling invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. The `sp print` subcommand
	 * processes a prompt and exits, printing the result to stdout.
	 *
	 * Used by merge/resolver.ts (AI-assisted conflict resolution) and
	 * watchdog/triage.ts (AI-assisted failure classification).
	 *
	 * @param prompt - The prompt to pass as the argument
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["sp", "print"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		cmd.push(prompt);
		return cmd;
	}

	/**
	 * Build the argv array for Bun.spawn() to launch a Sapling agent subprocess.
	 *
	 * Returns an argv array that starts the Sapling agent in RPC mode. The agent
	 * reads its instructions from the file at `opts.instructionPath`, processes
	 * the task, emits NDJSON events on stdout, and exits on completion.
	 *
	 * @param opts - Direct spawn options (cwd, env, model, instructionPath)
	 * @returns Argv array for Bun.spawn — do not shell-interpolate
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		return [
			"sp",
			"run",
			"--model",
			opts.model,
			"--mode",
			"rpc",
			"--cwd",
			opts.cwd,
			"--instructions",
			opts.instructionPath,
		];
	}

	/**
	 * Deploy per-agent instructions and guard configuration to a worktree.
	 *
	 * Writes the overlay content to `SAPLING.md` in the worktree root.
	 * Also writes `.sapling/guards.json` with the full guard configuration
	 * derived from `hooks` — translating overstory guard-rules.ts constants
	 * into JSON-serializable form for the `sp` CLI to enforce.
	 *
	 * When overlay is undefined (hooks-only deployment for coordinator/supervisor/monitor),
	 * this is a no-op since Sapling has no hook system to deploy.
	 *
	 * @param worktreePath - Absolute path to the agent's git worktree
	 * @param overlay - Overlay content to write as SAPLING.md, or undefined for no-op
	 * @param hooks - Agent identity, capability, and quality gates for guard config
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		hooks: HooksDef,
	): Promise<void> {
		if (!overlay) return;

		// Write SAPLING.md instruction file.
		const saplingPath = join(worktreePath, this.instructionPath);
		await mkdir(dirname(saplingPath), { recursive: true });
		await Bun.write(saplingPath, overlay.content);

		// Write .sapling/guards.json with full guard configuration.
		// Translates overstory guard-rules.ts constants into JSON for the `sp` CLI.
		const guardsPath = join(worktreePath, ".sapling", "guards.json");
		await mkdir(dirname(guardsPath), { recursive: true });
		await Bun.write(guardsPath, `${JSON.stringify(buildGuardsConfig(hooks), null, 2)}\n`);
	}

	/**
	 * Sapling is headless — always ready.
	 *
	 * Sapling runs as a direct subprocess that emits a `{"type":"ready"}` event
	 * on stdout when initialization completes. Tmux-based readiness detection
	 * is never used for Sapling workers.
	 *
	 * @param _paneContent - Captured tmux pane content (unused)
	 * @returns Always `{ phase: "ready" }`
	 */
	detectReady(_paneContent: string): ReadyState {
		return { phase: "ready" };
	}

	/**
	 * Sapling does not require beacon verification/resend.
	 *
	 * The beacon verification loop exists because Claude Code's TUI sometimes
	 * swallows the initial Enter during late initialization. Sapling is headless —
	 * it communicates via stdin/stdout with no TUI startup delay.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Parse a Sapling NDJSON transcript file into normalized token usage.
	 *
	 * Sapling emits NDJSON events on stdout during execution. The transcript
	 * file records these events. Token usage is extracted from events that
	 * carry a `usage` object with `input_tokens` and/or `output_tokens` fields.
	 * Model identity is extracted from any event that carries a `model` field.
	 *
	 * Returns null if the file does not exist or cannot be parsed.
	 *
	 * @param path - Absolute path to the Sapling NDJSON transcript file
	 * @returns Aggregated token usage, or null if unavailable
	 */
	async parseTranscript(path: string): Promise<TranscriptSummary | null> {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return null;
		}

		try {
			const text = await file.text();
			const lines = text.split("\n").filter((l) => l.trim().length > 0);

			let inputTokens = 0;
			let outputTokens = 0;
			let model = "";

			for (const line of lines) {
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// Skip malformed lines — partial writes during capture.
					continue;
				}

				// Extract token usage from any event carrying a usage object.
				if (typeof event.usage === "object" && event.usage !== null) {
					const usage = event.usage as Record<string, unknown>;
					if (typeof usage.input_tokens === "number") {
						inputTokens += usage.input_tokens;
					}
					if (typeof usage.output_tokens === "number") {
						outputTokens += usage.output_tokens;
					}
				}

				// Capture model from any event that carries it.
				if (typeof event.model === "string" && event.model && !model) {
					model = event.model;
				}
			}

			return { inputTokens, outputTokens, model };
		} catch {
			return null;
		}
	}

	/**
	 * Parse NDJSON stdout from a Sapling agent subprocess into typed AgentEvent objects.
	 *
	 * Reads the ReadableStream from Bun.spawn() stdout, buffers partial lines,
	 * and yields a typed AgentEvent for each complete JSON line. Malformed lines
	 * (partial writes, non-JSON output) are silently skipped.
	 *
	 * The NDJSON format mirrors Pi's `--mode json` output so `ov feed`, `ov trace`,
	 * and `ov costs` work without runtime-specific parsing.
	 *
	 * @param stream - ReadableStream<Uint8Array> from Bun.spawn stdout
	 * @yields Parsed AgentEvent objects in emission order
	 */
	async *parseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;

				buffer += decoder.decode(result.value, { stream: true });

				// Split on newlines, keeping the remainder in the buffer.
				const lines = buffer.split("\n");
				// The last element is either empty or an incomplete line.
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					try {
						const event = JSON.parse(trimmed) as AgentEvent;
						yield event;
					} catch {
						// Skip malformed lines — partial writes or debug output.
					}
				}
			}

			// Flush any remaining buffer content after stream ends.
			const remaining = buffer.trim();
			if (remaining) {
				try {
					const event = JSON.parse(remaining) as AgentEvent;
					yield event;
				} catch {
					// Skip malformed trailing line.
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 *
	 * Returns the provider environment variables from the resolved model.
	 * For Sapling native: may include SAPLING_API_KEY or provider-specific vars.
	 * For gateway providers: may include gateway-specific auth and routing vars.
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map (may be empty)
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}
}
