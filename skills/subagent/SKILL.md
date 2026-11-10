---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` tool to delegate work to a separate Pi process with its own context and tmux session. Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions.

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the returned handle remains its stable identifier:

```json
{ "action": "spawn", "name": "implementation", "prompt": "Complete task" }
```

The child inherits the calling session's provider, model, thinking level, and working directory. Set `provider`, `model`, `thinking`, or `cwd` only when deliberately choosing something different, for example a faster model for simple investigation or a stronger model for difficult review. Never pass the current provider and model back just to restate them.

`prompt` becomes the first user turn. `files` passes file paths as `@`-references, and both are combined when you provide several. Spawn returns the handle and the exact tmux attach command; keep the handle for later calls.

## Tools

The child starts with the calling session's default tools: `read`, `bash`, `edit`, and `write`, plus whatever `defaultTools` and installed extensions add. `grep`, `find`, `ls`, and `codemode` are off unless named.

`tools` narrows that selection, in one of two forms:

- Plain names replace it: `"read,grep,find,ls"` is read-only. Add `bash` only when the child must run commands, since `bash` can also write files.
- Only `+name`/`-name` entries edit it: `"+codemode,-write"`. Do not mix the forms.

Omit `tools` for implementation work. It does not filter MCP tools; use `noExtensions` or `mcp__<server>__*` entries for that.

## Isolation flags

- `noExtensions` - Disable normal extension discovery. Use for an independent run that should not inherit unrelated extension behavior or extension-provided tools. The subagent control bridge is still explicitly loaded.
- `noSkills` - Hide installed skills from the child. Use for tightly specified tasks that should rely only on the supplied prompt and files.
- `noPromptTemplates` - Disable prompt-template commands. Usually unnecessary, but useful when testing a minimal child environment.
- `noContextFiles` - Ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation. Do not use for implementation unless intentionally bypassing repository guidance.

Subagents persist after their current turn completes: waiting, completion, and becoming idle do not terminate them. They survive `/reload`. When the spawning Pi session quits or is replaced, they are suspended and relaunched idle with their history when that session is resumed. They are only removed by `stop`.

## Inspect and wait

```json
{ "action": "list" }
{ "action": "status", "handle": "a1b2c3" }
{ "action": "wait", "handle": "a1b2c3" }
```

Run `list` at any time to rediscover active subagents and their handles, names, and current states if you no longer remember them.

`wait` follows the durable session state and returns the latest final assistant response. Do not infer completion from captured terminal text. The default deadline is 1800 seconds; raise it with `timeoutSeconds` for long work.

## Communicate

```json
{ "action": "rename", "handle": "a1b2c3", "name": "new name" }
{ "action": "send", "handle": "a1b2c3", "message": "message" }
{ "action": "send", "handle": "a1b2c3", "message": "message", "followUp": true }
```

`send` without `followUp` prompts an idle subagent and steers a busy one. With `followUp`, a busy subagent finishes its current turn first. Names are 1–64 characters and need not be unique. Messages use the extension's control inbox; do not use `tmux send-keys`.

## Stop

```json
{ "action": "stop", "handle": "a1b2c3" }
```

Explicitly stop every subagent when it is no longer needed; do not leave completed subagents idle. This terminates tmux and removes the run transcript and metadata. Keep an idle subagent alive only when concrete follow-up work is expected, then stop it afterward.

The interactive `/subagent` command lists active subagents spawned by the current Pi session. Selecting one suspends the current Pi TUI and attaches to its tmux session; detaching returns to the parent Pi. When the parent already runs inside tmux, selection switches the current tmux client instead.
