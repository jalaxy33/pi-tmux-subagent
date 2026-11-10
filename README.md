# pi-tmux-subagent

Forked from [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent). Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation. Each one runs in its own tmux session with a dedicated Pi session, so you can watch it work, steer it, wait for its result, or attach to its terminal.

## Requirements

- Pi
- tmux

## Install

```sh
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
