import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { runSubagentCommand } from "./commands.ts";
import {
	effectiveRunState,
	inboxDir,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	type InboxMessage,
	type RunMetadata,
	tmuxSessionExists,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

const subagentParameters = Type.Object({
	action: Type.Union(
		[
			Type.Literal("spawn"),
			Type.Literal("list"),
			Type.Literal("status"),
			Type.Literal("wait"),
			Type.Literal("send"),
			Type.Literal("rename"),
			Type.Literal("stop"),
		],
		{ description: "Command to run" },
	),
	handle: Type.Optional(
		Type.String({ description: "Subagent handle from spawn. Required for every action except spawn and list." }),
	),
	name: Type.Optional(
		Type.String({ description: "spawn: display name, 1 to 64 characters. rename: the new name." }),
	),
	prompt: Type.Optional(Type.String({ description: "spawn: task text for the subagent's first user turn." })),
	files: Type.Optional(
		Type.Array(Type.String(), { description: "spawn: files to hand to the subagent as @-references." }),
	),
	provider: Type.Optional(Type.String({ description: "spawn: model provider. Defaults to the calling session's." })),
	model: Type.Optional(Type.String({ description: "spawn: model id. Defaults to the calling session's." })),
	thinking: Type.Optional(Type.String({ description: "spawn: thinking level. Defaults to the calling session's." })),
	cwd: Type.Optional(Type.String({ description: "spawn: working directory. Defaults to the calling session's." })),
	tools: Type.Optional(
		Type.String({ description: "spawn: comma-separated tool allowlist, for example read,grep,find,ls." }),
	),
	noExtensions: Type.Optional(
		Type.Boolean({ description: "spawn: disable extension discovery except the control bridge." }),
	),
	noSkills: Type.Optional(Type.Boolean({ description: "spawn: disable skills." })),
	noPromptTemplates: Type.Optional(Type.Boolean({ description: "spawn: disable prompt templates." })),
	noContextFiles: Type.Optional(Type.Boolean({ description: "spawn: ignore repository instruction files." })),
	message: Type.Optional(Type.String({ description: "send: message for the subagent." })),
	followUp: Type.Optional(
		Type.Boolean({ description: "send: queue the message after the current turn instead of steering it." }),
	),
	timeoutSeconds: Type.Optional(Type.Number({ description: "wait: timeout in seconds. Defaults to 1800." })),
});

type SubagentToolParams = Static<typeof subagentParameters>;

const subagentTool = defineTool({
	name: "subagent",
	label: "Subagent",
	description: `Manage observable Pi subagents. Each subagent runs in its own tmux session with its own Pi session and context, so it can investigate or implement work without crowding this conversation.

Actions:
- spawn: start a subagent; returns its handle and tmux attach command.
- list: show the subagents spawned by this session with their state.
- status: show one subagent's state.
- wait: block until the subagent finishes its turn and return its final message.
- send: steer a running subagent, or queue a follow-up with followUp.
- rename: change the display name.
- stop: terminate the subagent and delete its transcript.

Spawn for work that benefits from an independent context, then wait for the result. Stop every subagent when its work is no longer needed.`,
	promptSnippet: "spawn and manage observable Pi subagents with their own session and tmux terminal",
	promptGuidelines: [
		"Use the subagent tool for independent reviews, investigations, and delegated implementation instead of doing everything in one context. Stop subagents you no longer need.",
	],
	parameters: subagentParameters,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const result = await runSubagentCommand(
			buildArgv(params),
			{
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				provider: ctx.model?.provider,
				model: ctx.model?.id,
				thinking: ctx.thinkingLevel,
				cwd: ctx.cwd,
			},
			signal,
		);
		return {
			content: [{ type: "text" as const, text: result.output }],
			details: { action: params.action, ok: result.ok },
			isError: !result.ok,
		};
	},
});

function buildArgv(params: SubagentToolParams): string[] {
	const argv: string[] = [params.action];
	switch (params.action) {
		case "spawn":
			if (params.name) argv.push("--name", params.name);
			if (params.provider) argv.push("--provider", params.provider);
			if (params.model) argv.push("--model", params.model);
			if (params.thinking) argv.push("--thinking", params.thinking);
			if (params.cwd) argv.push("--cwd", params.cwd);
			if (params.tools) argv.push("--tools", params.tools);
			if (params.noExtensions) argv.push("--no-extensions");
			if (params.noSkills) argv.push("--no-skills");
			if (params.noPromptTemplates) argv.push("--no-prompt-templates");
			if (params.noContextFiles) argv.push("--no-context-files");
			for (const file of params.files ?? []) argv.push("--file", file);
			if (params.prompt) argv.push("--prompt", params.prompt);
			return argv;
		case "list":
			return argv;
		case "rename":
			if (!params.handle || !params.name) throw new Error("rename requires handle and name");
			return [...argv, params.handle, params.name];
		case "send":
			if (!params.handle || !params.message) throw new Error("send requires handle and message");
			return [...argv, params.handle, ...(params.followUp ? ["--follow-up"] : []), params.message];
		case "wait":
			if (!params.handle) throw new Error("wait requires a handle");
			return [...argv, params.handle, ...(params.timeoutSeconds != null ? ["--timeout", String(params.timeoutSeconds)] : [])];
		default:
			if (!params.handle) throw new Error(`${params.action} requires a handle`);
			return [...argv, params.handle];
	}
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
		pi.registerTool(subagentTool);
	}

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run) !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			let tui: TUI | undefined;
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				tui = customTui;
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
				container.addChild(list);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected || !tui) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;

			if (process.env.TMUX) {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["switch-client", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}

			tui.stop();
			try {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["attach-session", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
				return widgetContext!.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[widgetContext.ui.theme.fg("dim", "subagents: ") + visible.join(widgetContext.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			);
		};

		pi.on("session_start", (_event, ctx) => {
			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended || tmuxSessionExists(run.tmuxSession)) continue;
				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.runDir);
					continue;
				}
				const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
				try {
					launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!tmuxSessionExists(run.tmuxSession)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
				await waitForRunShutdown(run.runDir);
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
