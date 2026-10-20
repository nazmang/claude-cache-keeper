# claude-cache-keeper

Keeps long-lived [Claude Code](https://claude.com/claude-code) sessions cheap to wake up.

[Русская версия](README.ru.md)

> `agents`, the agents-panel and push-guard mods used to live here. They moved
> to [claude-agents-kit](https://github.com/nazmang/claude-agents-kit).

## The problem

If you keep several Claude Code sessions open for days (an agent team in tmux,
a few project tabs), most of the bill is not the work itself but the
wake-ups.

- The prompt cache lives 1 hour after the last request to the model.
- While it is alive, the context is read from the cache at a fraction of the price.
- After an hour of idling the cache is gone. The next message (yours, another
  agent's, a scheduled ping) writes the whole context into the cache again
  at full price. A 400k-token session pays for 400k tokens just to say "ok".
- Pinging a session to "keep the cache warm" only buys another hour and costs
  money every time. An idle open session costs nothing.

The fix: `/compact` a large idle session a few minutes before the cache
expires. Compaction still reads the context from the cache (cheap) and leaves a
short summary, so the next wake-up is small.

## What is inside

| part | what it does | needs |
|---|---|---|
| `plugins/cache-keeper/` (the mod) | Every session watches its own idle time. At minute 50, if the context is above 60k tokens, it compacts itself (`$.session.compact()`). `/cache` shows how long the cache has left. If you type into a session whose cache has already gone cold, it asks first: compact then send, send as is, or keep the draft. | Claude Code with mods (tested on 2.1.296) |
| `statusline/` | `💾 42m` countdown in the status line; yellow under 10 min, grey when expired. | `jq` |

Each session compacts itself, so there is no daemon, no timer and no tmux
requirement. A session started before the mod was installed does not have it:
restart it once.

> Until October 2026 the repo also shipped a systemd timer that typed
> `/compact` into idle tmux panes as a fallback. After the mod was installed it
> fired 4 times on the first day and never again in a week, so it was removed.

## Does it pay off

Measured on one machine with ~10 long-lived sessions (an agent team in tmux plus
project tabs), from the transcripts' `usage` fields only. Cost is in input-token
equivalents (1-hour cache write 2.0, cache read 0.1, input 1.0, output 5.0), so
models with different prices add up.

| per day, average | before (9 days) | after (6 days) |
|---|---|---|
| requests | 1041 | 1577 |
| cold wake-ups (> 60 min idle) | 11 | 21 |
| tokens written to the cache **per cold wake-up** | 536k | **61k** (−89 %) |
| cache writes on cold wake-ups | 5.9M | 1.3M (−78 %) |
| cost per request | 67k | **25k** (−63 %) |

- The per-wake-up line is the clean effect: it barely depends on how much work
  was done. The per-request drop also includes other changes in how the
  sessions were used.
- Compactions are not free: each one reads the context from the cache and
  writes a summary (~5k output tokens). Over 6 days 158 compactions cost about
  6.5M equivalents and saved about 26M on the wake-ups that followed: net
  ≈ 3M a day.
- 8 of 158 sessions were never woken again: that compaction was wasted. A
  context under `CACHE_KEEPER_MIN_TOKENS` is skipped for the same reason.

To measure your own: compare the average `cache_creation_input_tokens` of the
first request after more than an hour of silence, before and after installing.

## Install

```bash
git clone https://github.com/nazmang/claude-cache-keeper ~/src/claude-cache-keeper
~/src/claude-cache-keeper/install.sh
```

The installer cuts a release (`release.sh`) and links `cache-segment.sh` from it
into `~/.local/bin`. It does not touch `settings.json`; add this yourself:

```jsonc
// ~/.claude/settings.json
{
  // several plugins: colon-separated (a comma does not work)
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.local/share/claude-cache-keeper/current/plugins/cache-keeper" },
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
> the plugin dir list is read at process start. Restart them (after `/compact`!).

## Usage

- Inside a session: `/cache` →
  `cache left ~40 min; context 120k; will compact after 30 more min idle`.
- Is the mod working? It writes no log file. Look for `compact_boundary` in a
  session's transcript about 50 minutes after its last reply, or run `/cache`.
- A table of all live sessions with idle time, cache left and context:
  `agents status` from [claude-agents-kit](https://github.com/nazmang/claude-agents-kit).

### Releases: never load mods from the tree you edit

Running sessions hot-reload a mod whenever its files change. If settings
point at your working tree, every half-finished save lands in every agent at
once (we learned this the hard way). So:

- `./release.sh` refuses uncommitted changes, runs `claude plugin validate` and
  `claude plugin test` for every plugin, copies the committed `plugins/` and
  `statusline/` to `~/.local/share/claude-cache-keeper/releases/<sha>`
  and switches `current` atomically. `--list`, `--rollback <sha>`.
- Settings and `~/.local/bin/cache-segment.sh` point at
  `~/.local/share/claude-cache-keeper/current/...`, never at the repo.
- It also refuses untracked files: a file that only exists in your tree
  would be missing from every other clone (`release.sh` itself once was).
- Develop in a separate worktree (`git worktree add ../claude-cache-keeper-dev -b dev`),
  merge into `main`, then release.

### Tuning

| variable | default | where |
|---|---|---|
| `CACHE_KEEPER_AT_MIN` | 50 | mod: compact after N idle minutes |
| `CACHE_KEEPER_MIN_TOKENS` | 60000 | mod: skip smaller contexts |
| `CACHE_KEEPER_CACHE_MIN` | 60 | mod: cache TTL |
| `CACHE_KEEPER_TICK_MS` | 60000 | mod: check interval |
| `CACHE_TTL_MIN` | 60 | status line |
| `AGENTS_LANG` | from locale | `ru` or `en` for everything a person reads (status line, `/cache`, the dialog). Unset: the first non-empty of `LC_ALL`, `LC_MESSAGES`, `LANG` - `ru…` means Russian, anything else English. The text the model gets is never translated |

If you are on the 5-minute cache TTL (e.g. usage overage), these defaults do
not help — the cache is gone long before minute 50.

## Safety

- The mod uses `$.session.compact()`, which refuses while a turn is running;
  the next tick retries. A half-typed draft in the input box is preserved.
- Subagent turns do not reset the idle clock: they have their own cache.
- The cold-cache question only stops prompts typed by a person (terminal or
  phone bridge); messages from other sessions, task notifications and
  scheduled triggers go through untouched. Compaction cannot run inside the
  submit hook, so "compact then send" drops the prompt, compacts, and you
  press Enter again.
- Thresholds (`CACHE_KEEPER_*`) are read from `settings.json` `env`, not from
  the shell environment.

## Lessons learned

- Do not decide that `/compact` has finished by looking at the screen: an old
  `Compacted` line may still be visible. Check the transcript for a new
  `compact_boundary`.
- A compaction from inside the session beats one typed in from outside: an
  external timer had to guess from the screen whether the input box was empty
  and whether the session was busy.
- Before restarting a session with `--resume`, compact it first, otherwise the
  whole uncompacted tail is written to the cache again.
- The last `usage` in a transcript overstates the context if a compaction came
  after it.
- Running sessions hot-reload a mod on every save, hence `release.sh`.
- `$.session.compact()` cannot be called from the `prompt.submit` hook: it
  holds the turn.

## Tests

```bash
claude --plugin-dir plugins/cache-keeper   # once, interactively: generates .claude-plugin/types
claude plugin validate plugins/cache-keeper && claude plugin test plugins/cache-keeper
```

## Uninstall

```bash
rm ~/.local/bin/cache-segment.sh
```

Remove `CLAUDE_CODE_PLUGIN_DIRS` and the status line from `settings.json`, then
restart the sessions. `~/.local/share/claude-cache-keeper/` can be deleted
afterwards.

Upgrading from an older layout: remove the timer if you have one
(`systemctl --user disable --now agents-compact-idle.timer cache-keeper-idle.timer`,
then delete their unit files from `~/.config/systemd/user/` and
`~/.local/bin/cache-keeper-idle`), run `install.sh`, and install
`claude-agents-kit` if you use `agents` or the other mods.

## License

MIT
