import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./shared.ts";

export type SubagentExposure = "direct" | "deferred";

export interface SubagentConfig {
	exposure: SubagentExposure;
	/** Where the exposure came from, so `/subagent config` can explain it. */
	source: "env" | "project" | "global" | "default";
	path?: string;
}

const CONFIG_FILE = "subagent.json";
const EXPOSURE_ENV = "PI_SUBAGENT_EXPOSURE";

let warned = false;
function warn(message: string): void {
	// Load-time warnings repeat for every extension instance; the first one carries the reason.
	if (warned) return;
	warned = true;
	console.warn(`[pi-tmux-subagent] ${message}`);
}

export function subagentConfigPaths(cwd: string): { project: string; global: string } {
	return {
		project: join(cwd, ".pi", CONFIG_FILE),
		global: join(getAgentDir(), CONFIG_FILE),
	};
}

function parseExposure(value: unknown): SubagentExposure | undefined {
	return value === "direct" || value === "deferred" ? value : undefined;
}

function exposureFromFile(path: string): SubagentExposure | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		warn(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); ignoring it`);
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warn(`${path} must contain a JSON object; ignoring it`);
		return undefined;
	}
	const value = (parsed as Record<string, unknown>).exposure;
	if (value === undefined) return undefined;
	const exposure = parseExposure(value);
	if (!exposure) warn(`${path}: "exposure" must be "direct" or "deferred"; ignoring it`);
	return exposure;
}

/**
 * Env overrides the project file, which overrides the global file. A missing or unreadable source
 * falls through to the next one, so a broken config never takes the tool away.
 */
export function readSubagentConfig(cwd = process.cwd()): SubagentConfig {
	const fromEnv = process.env[EXPOSURE_ENV];
	if (fromEnv !== undefined) {
		const value = fromEnv.trim().toLowerCase();
		if (value === "direct" || value === "deferred") return { exposure: value, source: "env" };
		// An empty value is how shells express "unset", so it falls through without a warning.
		if (value !== "") warn(`${EXPOSURE_ENV} must be "direct" or "deferred"; ignoring ${JSON.stringify(fromEnv)}`);
	}
	const paths = subagentConfigPaths(cwd);
	for (const [source, path] of [["project", paths.project], ["global", paths.global]] as const) {
		const exposure = exposureFromFile(path);
		if (exposure) return { exposure, source, path };
	}
	return { exposure: "direct", source: "default" };
}

export function describeSubagentConfig(config: SubagentConfig, cwd = process.cwd()): string {
	const paths = subagentConfigPaths(cwd);
	const origin = config.path ? `${config.source} ${config.path}` : config.source;
	return [
		`exposure: ${config.exposure} (${origin})`,
		`global:   ${paths.global}`,
		`project:  ${paths.project}`,
		`${EXPOSURE_ENV}: ${process.env[EXPOSURE_ENV] ?? "unset"}`,
	].join("\n");
}
