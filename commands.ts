import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assistantText,
	effectiveRunState,
	getRunsDir,
	inboxDir,
	launchRun,
	listRuns,
	readLatestAssistant,
	readMetadata,
	removeRunDir,
	runDisplayName,
	isValidRunName,
	type InboxMessage,
	type RunMetadata,
	tmuxSessionExists,
	updateMetadata,
	waitForRunShutdown,
	writeMetadata,
} from "./shared.ts";

/** Session values the caller passes in: the CLI reads them from the environment, the tool from its context. */
export interface CommandContext {
	sessionId?: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	cwd: string;
}

export interface CommandResult {
	output: string;
	ok: boolean;
}

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
	fail(`Usage:
  subagent spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]
    [--cwd <dir>] [--tools <names>] [--no-extensions] [--no-skills]
    [--no-prompt-templates] [--no-context-files] (--prompt <text> | --file <path>)...
  subagent status <handle>
  subagent rename <handle> <name>
  subagent send <handle> [--follow-up] <message>
  subagent wait <handle> [--timeout <seconds>]
  subagent stop <handle>
  subagent list`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) fail("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

function runDirForHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) fail(`Invalid subagent handle: ${handle}`);
	return join(getRunsDir(), handle);
}

function getRun(handle: string): RunMetadata {
	const metadata = readMetadata(runDirForHandle(handle));
	if (!metadata) fail(`Unknown subagent: ${handle}`);
	return metadata;
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(runDirForHandle(handle))) return handle;
	}
	fail("Could not allocate a unique subagent handle");
}

function spawnSubagent(args: string[], context: CommandContext): string {
	if (process.env.PI_SUBAGENT_RUN_DIR) fail("Nested subagents are disabled");
	let name: string | undefined;
	let provider = context.provider;
	let model = context.model;
	let thinking = context.thinking || "medium";
	let cwd = context.cwd;
	let tools: string | undefined;
	let noExtensions = false;
	let noSkills = false;
	let noPromptTemplates = false;
	let noContextFiles = false;
	const prompts: string[] = [];
	const files: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--name":
				name = normalizeRunName(valueAfter(args, i, arg));
				i++;
				break;
			case "--provider":
				provider = valueAfter(args, i, arg);
				i++;
				break;
			case "--model":
				model = valueAfter(args, i, arg);
				i++;
				break;
			case "--thinking":
				thinking = valueAfter(args, i, arg);
				i++;
				break;
			case "--cwd":
				cwd = resolve(context.cwd, valueAfter(args, i, arg));
				i++;
				break;
			case "--tools":
				tools = valueAfter(args, i, arg);
				i++;
				break;
			case "--no-extensions":
				noExtensions = true;
				break;
			case "--no-skills":
				noSkills = true;
				break;
			case "--no-prompt-templates":
				noPromptTemplates = true;
				break;
			case "--no-context-files":
				noContextFiles = true;
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, arg));
				i++;
				break;
			case "--file": {
				const file = resolve(context.cwd, valueAfter(args, i, arg));
				if (!existsSync(file)) fail(`File not found: ${file}`);
				files.push(file);
				i++;
				break;
			}
			default:
				fail(`Unknown spawn argument: ${arg}`);
		}
	}

	if (!provider) fail("No provider specified and no provider in the calling session");
	if (!model) fail("No model specified and no model in the calling session");
	if (!VALID_THINKING_LEVELS.has(thinking)) fail(`Invalid thinking level: ${thinking}`);
	if (tools !== undefined && !tools.split(",").some((name) => name.trim()))
		fail("--tools requires at least one tool name");
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`Working directory not found: ${cwd}`);

	const handle = generateHandle();
	const runDir = runDirForHandle(handle);
	const sessionFile = join(runDir, "session.jsonl");
	const tmuxSession = `pi-subagent-${handle}`;
	mkdirSync(inboxDir(runDir), { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, "", { mode: 0o600 });

	const launchArgs: string[] = ["--extension", extensionPath];
	if (tools) launchArgs.push("--tools", tools);
	// The bridge must load even when the parent got this extension through -e or a package, so pass it explicitly.
	if (noExtensions) launchArgs.push("--no-extensions");
	if (noSkills) launchArgs.push("--no-skills");
	if (noPromptTemplates) launchArgs.push("--no-prompt-templates");
	if (noContextFiles) launchArgs.push("--no-context-files");

	const now = new Date().toISOString();
	const metadata: RunMetadata = {
		version: 1,
		handle,
		name,
		parentSessionId: context.sessionId,
		parentSessionFile: context.sessionFile,
		tmuxSession,
		runDir,
		sessionFile,
		cwd,
		provider,
		model,
		thinking,
		launchArgs,
		state: "starting",
		hasStarted: false,
		createdAt: now,
		updatedAt: now,
	};
	writeMetadata(metadata);

	const initialArgs = files.map((file) => `@${file}`);
	if (prompts.length > 0) initialArgs.push(`Task:\n${prompts.join("\n\n")}`);
	try {
		launchRun(metadata, initialArgs);
	} catch (error) {
		removeRunDir(runDir);
		throw error;
	}

	return `Spawned ${runDisplayName(metadata)}\nState: busy\nAttach: tmux attach -t ${tmuxSession}\n`;
}

function statusSubagent(args: string[]): string {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	return `${runDisplayName(metadata)}: ${effectiveRunState(metadata)} (${metadata.provider}/${metadata.model}, ${metadata.thinking})\nAttach: tmux attach -t ${metadata.tmuxSession}\n`;
}

function renameSubagent(args: string[]): string {
	if (args.length !== 2) usage();
	const metadata = getRun(args[0]);
	const name = normalizeRunName(args[1]);
	const updated = updateMetadata(metadata.runDir, { name });
	if (!updated) fail(`Could not rename subagent: ${metadata.handle}`);
	return `Renamed ${runDisplayName(updated)}\n`;
}

function sendSubagent(args: string[]): string {
	const handle = args.shift();
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of args) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const metadata = getRun(handle);
	if (!tmuxSessionExists(metadata.tmuxSession)) fail(`${handle} is not running`);

	const queueDir = inboxDir(metadata.runDir);
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const target = join(queueDir, `${id}.json`);
	const temporary = `${target}.tmp`;
	const payload: InboxMessage = { message, delivery: followUp ? "followUp" : "auto" };
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);

	const state = effectiveRunState(metadata);
	const verb = followUp && state === "busy" ? "Queued follow-up for" : state === "idle" ? "Prompted" : "Steered";
	return `${verb} ${runDisplayName(metadata)}\n`;
}

function parseTimeout(args: string[]): number {
	if (args.length === 0) return 1800;
	if (args.length !== 2 || args[0] !== "--timeout") usage();
	const timeout = Number(args[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return timeout;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolveDelay, rejectDelay) => {
		if (signal?.aborted) {
			rejectDelay(new Error("Subagent wait cancelled"));
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			rejectDelay(new Error("Subagent wait cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolveDelay();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitSubagent(args: string[], signal?: AbortSignal): Promise<CommandResult> {
	const handle = args.shift();
	if (!handle) usage();
	const timeoutSeconds = parseTimeout(args);
	const deadline = Date.now() + timeoutSeconds * 1000;

	while (Date.now() < deadline) {
		const metadata = getRun(handle);
		const pending = existsSync(inboxDir(metadata.runDir))
			? readdirSync(inboxDir(metadata.runDir)).some((file) => file.endsWith(".json"))
			: false;
		const state = effectiveRunState(metadata);
		if (state === "error") fail(metadata.error || `${handle} failed`);
		if (state === "exited") fail(`${handle} exited before finishing`);
		if (metadata.hasStarted && state === "idle" && !pending) {
			const message = readLatestAssistant(metadata.sessionFile);
			if (!message) fail(`${handle} finished without an assistant response`);
			const broken = message.stopReason === "error" || message.stopReason === "aborted";
			return { output: `${handle} finished\n\n${assistantText(message)}\n`, ok: !broken };
		}
		await delay(500, signal);
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

async function stopSubagent(args: string[]): Promise<string> {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	const wasRunning = tmuxSessionExists(metadata.tmuxSession);
	spawnSync("tmux", ["kill-session", "-t", metadata.tmuxSession], { stdio: "ignore" });
	if (wasRunning) await waitForRunShutdown(metadata.runDir);
	removeRunDir(metadata.runDir);
	return `Stopped ${runDisplayName(metadata)}\n`;
}

function listSubagents(args: string[], context: CommandContext): string {
	if (args.length !== 0) usage();
	const runs = listRuns(context.sessionId);
	if (runs.length === 0) return "No subagents\n";
	return runs
		.map(
			(metadata) =>
				`${runDisplayName(metadata)}  ${effectiveRunState(metadata).padEnd(8)}  ${metadata.provider}/${metadata.model}  ${metadata.thinking}\n`,
		)
		.join("");
}

export async function runSubagentCommand(
	argv: string[],
	context: CommandContext,
	signal?: AbortSignal,
): Promise<CommandResult> {
	const args = [...argv];
	switch (args.shift()) {
		case "spawn":
			return { output: spawnSubagent(args, context), ok: true };
		case "status":
			return { output: statusSubagent(args), ok: true };
		case "rename":
			return { output: renameSubagent(args), ok: true };
		case "send":
			return { output: sendSubagent(args), ok: true };
		case "wait":
			return waitSubagent(args, signal);
		case "stop":
			return { output: await stopSubagent(args), ok: true };
		case "list":
			return { output: listSubagents(args, context), ok: true };
		default:
			usage();
	}
}
