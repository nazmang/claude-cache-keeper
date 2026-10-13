# claude-cache-keeper

Keeps long-lived [Claude Code](https://claude.com/claude-code) sessions cheap to wake up.

[Русская версия](README.ru.md)

## The problem

If you keep several Claude Code sessions open for days (an agent team in tmux,
a few project tabs), most of the bill is not the work itself — it is the
**wake-ups**.

- The prompt cache lives **1 hour** after the last request to the model.
- While it is alive, the context is read from the cache at a fraction of the price.
- After an hour of idling the cache is gone. The next message — yours, another
  agent's, a scheduled ping — writes the **whole context** into the cache again
  at full price. A 400k-token session pays for 400k tokens just to say "ok".
- Pinging a session to "keep the cache warm" only buys another hour and costs
  money every time. An idle open session costs nothing.

The fix: `/compact` a large idle session a few minutes **before** the cache
expires. Compaction still reads the context from the cache (cheap) and leaves a
short summary, so the next wake-up is small.

## What is inside

| part | what it does | needs |
|---|---|---|
| `plugins/cache-keeper/` — **cache-keeper mod** | Every session watches its own idle time. At minute 50, if the context is above 60k tokens, it compacts itself (`$.session.compact()`). `/cache` shows how long the cache has left. If you type into a session whose cache has already gone cold, it asks first: compact then send, send as is, or keep the draft. | Claude Code with mods (tested on 2.1.296) |
| `bin/agents` | `agents status` — every live session on the machine: status, idle, cache left, context, model, tmux window. `agents compact-idle` — fallback compaction for sessions started without the mod. | Python 3, tmux for compaction |
| `systemd/` | Runs `agents compact-idle` every 2 min (window 53–59 min). | systemd user session |
| `statusline/` | `💾 42m` countdown in the status line; yellow under 10 min, grey when expired. | `jq` |
| `plugins/push-guard/` — **push-guard mod** | Stops `git push` to a branch whose PR is already merged (the commits would never reach the base branch) and asks **you** in a dialog; only your “yes” lets it run, otherwise the agent is told to start a fresh branch. There is no override the model can type itself. No answer within `PUSH_GUARD_ASK_MIN` minutes (10) is a refusal, so an unattended agent never hangs on the question; a desktop notification tells you an agent is waiting. Unknown repos and missing `gh` pass through. | `gh` logged in |
| `plugins/agents-panel/` — **agents-panel mod** | A band above the prompt with every live session on the machine — 👧/👦/🧒 per `people.conf`, coloured by model (Haiku blue, Sonnet amber, Opus purple, Fable green), ⏳ while working, 💤 when the cache is gone — and the open checklist items waiting on you. `/team` opens the full panel: model, idle, cache, context, waiting items by project. | `bin/agents` on `PATH` |

The layers overlap on purpose: the mod fires first; the timer catches sessions
that were started before the mod was installed; the status line lets a human
see it.

## Install

```bash
git clone https://github.com/nazmang/claude-cache-keeper ~/src/claude-cache-keeper
~/src/claude-cache-keeper/install.sh
```

The installer cuts a release (`release.sh`), links `agents` and
`cache-segment.sh` from it into `~/.local/bin` and enables the systemd timer. It does **not** touch `settings.json`; add this
yourself:

```jsonc
// ~/.claude/settings.json
{
  // several plugins: colon-separated (a comma does not work)
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.local/share/claude-cache-keeper/current/plugins/cache-keeper:/home/you/.local/share/claude-cache-keeper/current/plugins/push-guard:/home/you/.local/share/claude-cache-keeper/current/plugins/agents-panel" },
  "statusLine": {
    "type": "command",
    "command": "/home/you/src/claude-cache-keeper/statusline/example-statusline.sh",
    "refreshInterval": 30
  }
}
```

Or try a mod in one session: `claude --plugin-dir ~/src/claude-cache-keeper/plugins/cache-keeper`.

> Set the variable in `settings.json`, not in the shell: exported in the
> environment it was not picked up in our tests (Claude Code 2.1.296).

> **Running sessions do not pick the mod up**, not even with `/reload-plugins`:
> the plugin dir list is read at process start. Restart them (after `/compact`!)
> or rely on the systemd fallback.

## Usage

```text
$ agents status
session                      status      idle   cache   context  model / window
Coordinator                  idle         34m     26m   compact  sonnet-5-5 / team:Coordinator
Reviewer                     idle        114m expired      191k  opus-5-5 / team:Reviewer
webapp-dev                   busy          0m     60m       77k  opus-5-5 / no tmux
```

- `context` = `compact` means nothing has been added since the last compaction.
- `agents compact <name> --wait` — compact one session now and wait until the
  transcript gets a new `compact_boundary`.
- `agents up|down <project> [names…]` — start/stop a project's sessions in tmux.
  - Plain sessions: list them in `~/.config/agents/sessions.conf`
    (`project | name | dir | model | session id`). `up` opens tmux session
    `<project>`, one window per line, with `claude -n <name> --resume <id>`; a
    line without an id starts a new session and records its id. Sessions that
    are already running — in tmux or in some terminal tab — are left alone.
    `down` compacts each session first, then sends `/exit`; busy sessions and
    drafts in the input box are skipped.
  - Teams with their own start/stop scripts: `~/.config/agents/projects.conf`
    (`project | dir | up command | down command`).
  - Moving a session from a terminal tab into tmux: `/compact`, `/exit` in the
    tab, then `agents up <project>`.
- Inside a session: `/cache` →
  `cache left ~40 min; context 120k; will compact after 30 more min idle`.
- Log: `~/.local/state/agents/compact-idle.log`.

### Releases: never load mods from the tree you edit

Running sessions **hot-reload** a mod whenever its files change. If settings
point at your working tree, every half-finished save lands in every agent at
once (we learned this the hard way). So:

- `./release.sh` refuses uncommitted changes, runs `claude plugin validate` and
  `claude plugin test` for every plugin, copies the committed `bin/`,
  `plugins/` and `statusline/` to `~/.local/share/claude-cache-keeper/releases/<sha>`
  and switches `current` atomically. `--list`, `--rollback <sha>`.
- Settings, `~/.local/bin/agents` and the timer point at
  `~/.local/share/claude-cache-keeper/current/...`, never at the repo.
- Develop in a separate worktree (`git worktree add ../claude-cache-keeper-dev -b dev`),
  merge into `main`, then release.

### agents-panel data

The mod has no file system, so it asks `agents status --json --max-age 5`; the
answer is cached, so all sessions together recompute it at most every 5 s.

- `~/.config/agents/people.conf` — `session name | display name | f|m|-` (see `examples/`).
- Checklist: one JSON per item in `~/.local/state/agents/checklist/items/`
  (`{id, data: {project, title, who, status}}`) — e.g. a dump of a Claude
  artifact database. Open items (`status: todo`) whose `who` is in `OWNER_WHO`
  (default `owner,together,you` and their Russian twins) count as waiting on you.

### Tuning

| variable | default | where |
|---|---|---|
| `CACHE_KEEPER_AT_MIN` | 50 | mod: compact after N idle minutes |
| `CACHE_KEEPER_MIN_TOKENS` | 60000 | mod: skip smaller contexts |
| `CACHE_KEEPER_CACHE_MIN` | 60 | mod: cache TTL |
| `CACHE_KEEPER_TICK_MS` | 60000 | mod: check interval |
| `COMPACT_FROM` / `COMPACT_TO` | 53 / 59 | `agents compact-idle` window |
| `MIN_CTX` | 60000 | `agents compact-idle` threshold |
| `CACHE_TTL_MIN` | 60 | status line |

If you are on the 5-minute cache TTL (e.g. usage overage), these defaults do
not help — the cache is gone long before minute 50.

## Safety

- The mod uses `$.session.compact()`, which refuses while a turn is running;
  the next tick retries. A half-typed draft in the input box is preserved.
- `agents compact-idle` types `/compact` into a tmux pane only if the session
  status is `idle` **and** the input box is empty (detected on screen after the
  `❯` prompt). Sessions outside tmux are never touched.
- Subagent turns do not reset the idle clock — they have their own cache.
- The cold-cache question only stops prompts typed by a person (terminal or
  phone bridge); messages from other sessions, task notifications and
  scheduled triggers go through untouched. Compaction cannot run inside the
  submit hook, so "compact then send" drops the prompt, compacts, and you
  press Enter again.
- Thresholds (`CACHE_KEEPER_*`) are read from `settings.json` `env`, not from
  the shell environment.

## Lessons learned

- Do not decide that `/compact` has finished by looking at the screen: an old
  `Compacted` line may still be visible. `agents compact --wait` checks the
  transcript for a new `compact_boundary`.
- The timer interval must be well below the compaction window. With a 5-minute
  timer (which really fires every ~5.5 min) and a 4-minute window, a 191k
  session slipped through.
- Before restarting a session with `--resume`, compact it first — otherwise the
  whole uncompacted tail is written to the cache again.
- The last `usage` in a transcript overstates the context if a compaction came
  after it.

## Tests

```bash
claude --plugin-dir plugins/cache-keeper   # once, interactively: generates .claude-plugin/types
for p in plugins/*; do claude plugin validate $p && claude plugin test $p; done
```

## License

MIT
