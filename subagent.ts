#!/usr/bin/env node

import { runSubagentCommand } from "./commands.ts";

try {
	const result = await runSubagentCommand(process.argv.slice(2), {
		sessionId: process.env.PI_SESSION_ID,
		sessionFile: process.env.PI_SESSION_FILE,
		provider: process.env.PI_PROVIDER,
		model: process.env.PI_MODEL,
		thinking: process.env.PI_REASONING_LEVEL,
		cwd: process.cwd(),
	});
	process.stdout.write(result.output);
	if (!result.ok) process.exitCode = 1;
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
