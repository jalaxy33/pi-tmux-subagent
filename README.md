# pi-tmux-subagent

Forked from [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent). Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation. Each one runs in its own tmux session with a dedicated Pi session, so you can watch it work, steer it, wait for its result, or attach to its terminal.

## Requirements

- Pi
- tmux

Windows is not supported, because tmux has no native Windows build. Run Pi inside WSL2 instead. When tmux is missing, the extension registers no tool or command and reports the reason on session start.

Runs live under `~/.pi/agent/subagents` and are only listed by the session that spawned them. A run whose parent session file was deleted is removed on the next session start.

## Install

```sh
pi install npm:@jalaxy33/pi-tmux-subagent
# or from source
pi install git:github.com/jalaxy33/pi-tmux-subagent
```

Run `/reload` in an existing Pi session. The extension registers the `subagent` tool and its skill; there is no symlink to create and no `PATH` entry to add. The checkout also contains `subagent.ts`, which offers the same commands as a CLI for scripts.

## Usage

Ask for a subagent in plain language:

> Start a subagent named review that checks the current diff independently, then stop it once it has reported back.

- It inherits your provider, model, thinking level, and working directory. Ask for files, another model, or another directory when you need them.
- Restrict its tools by naming them, for example "give it only `read`, `grep`, `find`, and `ls`". That set is read-only; `bash` can also write files, so leave it out for reviews.
- Ask Pi to wait for the result, forward instructions while it works, rename the run, or stop it.
- `/subagent` lists this session's runs and attaches to one.

## Keep the tool out of the system prompt

The `subagent` tool is declared directly by default. Set `"exposure": "deferred"` to register it without declaring it: the tool stays available, but it no longer takes space in every request, and the model reaches it from codemode scripts as `tools.subagent({ action: ... })`.

Put the setting in one of these, highest precedence first:

| Where | Path |
| --- | --- |
| Environment | `PI_SUBAGENT_EXPOSURE=deferred` |
| Project | `.pi/subagent.json` in the repository |
| Global | `~/.pi/agent/subagent.json` |

```json
{ "exposure": "deferred" }
```

`/subagent config` prints the value in effect and where it came from. A missing file means the default; an unreadable one is reported once and ignored. The extension reads this file itself and never writes to Pi's `settings.json`.

A deferred tool needs `codemode` or `tool_search` in the session to be reachable. When neither is available, the extension activates the tool at session start, so the tool never becomes uncallable. To declare it for a single session without editing the file, start Pi with `pi --tools +subagent`. `/subagent` and the run widget work the same either way, and the skill explains both call styles.
