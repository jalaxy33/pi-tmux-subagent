import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	type RunMetadata,
	type RunState,
	effectiveRunState,
	pruneOrphanRuns,
	readMetadata,
	runDisplayName,
	runHandle,
	runTmuxSession,
} from "../shared.ts";

const CURRENT = "current-session";

let agentDir: string;
let runsDir: string;

before(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
	runsDir = join(agentDir, "subagents");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
});

/** Write a run directory. `extra` overrides fields; `raw` replaces the file contents entirely. */
function createRun(handle: string, extra: Record<string, unknown> = {}, raw?: string): string {
	const runDir = join(runsDir, handle);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(runDir, "metadata.json"),
		raw ??
			JSON.stringify({
				version: 2,
				runDir,
				sessionFile: join(runDir, "session.jsonl"),
				cwd: agentDir,
				provider: "provider",
				model: "model",
				thinking: "low",
				state: "idle",
				hasStarted: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				...extra,
			}),
	);
	return runDir;
}

function readRun(runDir: string): RunMetadata {
	const metadata = readMetadata(runDir);
	assert.ok(metadata, `expected readable metadata in ${runDir}`);
	return metadata;
}

describe("readMetadata", () => {
	test("reads a valid run and takes runDir from the directory", () => {
		const runDir = createRun("valid1", { runDir: "/elsewhere/stale" });
		const metadata = readRun(runDir);
		assert.equal(metadata.provider, "provider");
		assert.equal(metadata.runDir, runDir);
	});

	test("rejects metadata it cannot trust", () => {
		const cases: Array<[string, string | Record<string, unknown>]> = [
			["old1", JSON.stringify({ version: 1, sessionFile: "s" })],
			["new1", JSON.stringify({ version: 3, sessionFile: "s" })],
			["broken1", "{not json"],
			["nosession1", { sessionFile: undefined }],
			["badname1", { name: "" }],
			["badname2", { name: 7 }],
		];
		for (const [handle, content] of cases) {
			const runDir = createRun(handle, content as Record<string, unknown>, typeof content === "string" ? content : undefined);
			assert.equal(readMetadata(runDir), undefined, handle);
		}
	});

	test("treats a directory without metadata.json as unreadable", () => {
		const runDir = join(runsDir, "empty1");
		mkdirSync(runDir, { recursive: true });
		assert.equal(readMetadata(runDir), undefined);
	});
});

describe("run identity", () => {
	test("derives the handle and tmux session from the directory", () => {
		const runDir = createRun("abc123");
		const metadata = readRun(runDir);
		assert.equal(runHandle(runDir), "abc123");
		assert.equal(runTmuxSession(metadata), "pi-subagent-abc123");
		assert.equal(runDisplayName(metadata), "abc123");
		assert.equal(runDisplayName({ ...metadata, name: "review" }), "review (abc123)");
	});
});

describe("effectiveRunState", () => {
	let counter = 0;

	function stateOf(state: RunState, tmuxAlive: boolean): RunState {
		const runDir = createRun(`state-${state}-${counter++}`, { state });
		const metadata = readRun(runDir);
		const sessions = new Set(tmuxAlive ? [runTmuxSession(metadata)] : []);
		return effectiveRunState(metadata, sessions);
	}

	test("keeps the recorded state while the tmux session lives", () => {
		assert.equal(stateOf("starting", true), "starting");
		assert.equal(stateOf("busy", true), "busy");
		assert.equal(stateOf("idle", true), "idle");
	});

	test("reports exited when an active run lost its tmux session", () => {
		assert.equal(stateOf("starting", false), "exited");
		assert.equal(stateOf("busy", false), "exited");
		assert.equal(stateOf("idle", false), "exited");
	});

	test("leaves terminal states alone", () => {
		assert.equal(stateOf("exited", false), "exited");
		assert.equal(stateOf("error", false), "error");
	});
});

describe("pruneOrphanRuns", () => {
	test("removes only runs no session can reach", () => {
		const parentFile = join(agentDir, "parent-session.jsonl");
		writeFileSync(parentFile, "");

		const kept = [
			createRun("keep-live-parent", { parentSessionId: "other", parentSessionFile: parentFile }),
			createRun("keep-ephemeral-parent", { parentSessionId: "other" }),
			createRun("keep-current", { parentSessionId: CURRENT }),
			createRun("keep-newer-schema", { parentSessionId: "other", parentSessionFile: parentFile }, JSON.stringify({ version: 3 })),
		];
		mkdirSync(join(runsDir, "keep-no-metadata"), { recursive: true });
		const removed = [
			createRun("drop-missing-parent", { parentSessionId: "other", parentSessionFile: join(agentDir, "deleted.jsonl") }),
			createRun("drop-corrupt", {}, "{not json"),
			createRun("drop-old-schema", { parentSessionId: "other", parentSessionFile: parentFile }, JSON.stringify({ version: 1 })),
		];

		pruneOrphanRuns(CURRENT);

		// A kept directory may be unreadable by this version (newer schema), so check the directory itself.
		for (const runDir of kept) assert.ok(existsSync(join(runDir, "metadata.json")), `kept ${runDir}`);
		assert.ok(existsSync(join(runsDir, "keep-no-metadata")), "directories we did not create are left alone");
		for (const runDir of removed) assert.equal(existsSync(runDir), false, `removed ${runDir}`);
	});

	test("keeps the current session's runs even when its session file is gone", () => {
		const runDir = createRun("keep-current-stale", {
			parentSessionId: CURRENT,
			parentSessionFile: join(agentDir, "gone.jsonl"),
		});
		pruneOrphanRuns(CURRENT);
		assert.ok(readMetadata(runDir));
	});
});
