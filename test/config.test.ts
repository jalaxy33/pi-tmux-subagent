import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { readSubagentConfig, subagentConfigPaths } from "../config.ts";

let agentDir: string;
let projectDir: string;

before(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-config-"));
	projectDir = mkdtempSync(join(tmpdir(), "pi-subagent-project-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

beforeEach(() => {
	delete process.env.PI_SUBAGENT_EXPOSURE;
	rmSync(join(agentDir, "subagent.json"), { force: true });
	rmSync(join(projectDir, ".pi"), { recursive: true, force: true });
});

after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_SUBAGENT_EXPOSURE;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

function writeConfig(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

describe("readSubagentConfig", () => {
	test("defaults to direct without a config file", () => {
		const config = readSubagentConfig(projectDir);
		assert.equal(config.exposure, "direct");
		assert.equal(config.source, "default");
	});

	test("reads the global file", () => {
		writeConfig(subagentConfigPaths(projectDir).global, '{ "exposure": "deferred" }');
		const config = readSubagentConfig(projectDir);
		assert.equal(config.exposure, "deferred");
		assert.equal(config.source, "global");
	});

	test("project file overrides the global file", () => {
		writeConfig(subagentConfigPaths(projectDir).global, '{ "exposure": "direct" }');
		writeConfig(subagentConfigPaths(projectDir).project, '{ "exposure": "deferred" }');
		const config = readSubagentConfig(projectDir);
		assert.equal(config.exposure, "deferred");
		assert.equal(config.source, "project");
	});

	test("environment overrides both files", () => {
		writeConfig(subagentConfigPaths(projectDir).project, '{ "exposure": "direct" }');
		process.env.PI_SUBAGENT_EXPOSURE = "deferred";
		const config = readSubagentConfig(projectDir);
		assert.equal(config.exposure, "deferred");
		assert.equal(config.source, "env");
	});

	test("falls back to the next source when a file is unreadable", () => {
		writeConfig(subagentConfigPaths(projectDir).project, "{ not json");
		writeConfig(subagentConfigPaths(projectDir).global, '{ "exposure": "deferred" }');
		const config = readSubagentConfig(projectDir);
		assert.equal(config.exposure, "deferred");
		assert.equal(config.source, "global");
	});

	test("ignores an unknown exposure value", () => {
		writeConfig(subagentConfigPaths(projectDir).project, '{ "exposure": "sometimes" }');
		const config = readSubagentConfig(projectDir);
		assert.equal(config.exposure, "direct");
		assert.equal(config.source, "default");
	});

	test("ignores a non-string exposure and keeps looking", () => {
		writeConfig(subagentConfigPaths(projectDir).project, '{ "exposure": 5 }');
		writeConfig(subagentConfigPaths(projectDir).global, '{ "exposure": "deferred" }');
		const config = readSubagentConfig(projectDir);
		assert.equal(config.exposure, "deferred");
		assert.equal(config.source, "global");
	});

	test("skips a file without an exposure key", () => {
		writeConfig(subagentConfigPaths(projectDir).project, "{}");
		writeConfig(subagentConfigPaths(projectDir).global, '{ "exposure": "deferred" }');
		assert.equal(readSubagentConfig(projectDir).source, "global");
	});

	test("treats an empty environment value as unset", () => {
		writeConfig(subagentConfigPaths(projectDir).global, '{ "exposure": "deferred" }');
		process.env.PI_SUBAGENT_EXPOSURE = "  ";
		assert.equal(readSubagentConfig(projectDir).source, "global");
	});

	test("accepts a differently cased environment value", () => {
		process.env.PI_SUBAGENT_EXPOSURE = " Deferred ";
		const config = readSubagentConfig(projectDir);
		assert.equal(config.exposure, "deferred");
		assert.equal(config.source, "env");
	});

	test("resolves the global path under the agent directory", () => {
		assert.equal(subagentConfigPaths(projectDir).global, join(agentDir, "subagent.json"));
	});
});
