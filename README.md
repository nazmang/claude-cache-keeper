# claude-cache-keeper

**Make long-lived [Claude Code](https://claude.com/claude-code) sessions cheap to wake up.**

A Claude Code mod that compacts an idle session a few minutes before its prompt
cache expires, so the next message does not pay to rewrite the whole context.

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-D97757)
![Platform: Linux](https://img.shields.io/badge/platform-Linux-informational)

[Русская версия](README.ru.md)

- **−87 %** tokens written to the cache per cold wake-up (547k → 69k, 16 days)
- **−63 %** cost per request, **2.9M** input-token equivalents saved a day, net,
  on a machine with ~10 long-lived sessions
- No daemon, no timer, no tmux: every session looks after itself

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

## How it works

```
 last reply           minute 50                     minute 60
     │                    │                             │
─────●────────────────────●─────────────────────────────┼─────────────▶ time
     cache is warm        /compact while the cache      cache expired:
                          is still warm (cheap read,    the next wake-up writes
                          a short summary is left)      ~60k instead of ~500k
```

1. Every session tracks its own idle time.
2. At minute 50, if the context is above 60k tokens, the session compacts
   itself (`$.session.compact()`). Compaction still reads the context from the
   warm cache and leaves a short summary.
3. If you type into a session whose cache has already gone cold, the mod asks
   first: **compact then send**, **send as is**, or **keep the draft**.
4. `/cache` shows how long the cache has left and what the mod plans to do.
5. An optional status line segment shows a `💾 42m` countdown.

## Quick start

```bash
git clone https://github.com/nazmang/claude-cache-keeper ~/src/claude-cache-keeper
~/src/claude-cache-keeper/install.sh
```

Then add this to `~/.claude/settings.json` (replace `/home/you`):

```jsonc
{
  // several plugins: colon-separated (a comma does not work)
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.local/share/claude-cache-keeper/current/plugins/cache-keeper" },
  "statusLine": {
    "type": "command",
    "command": "/home/you/.local/share/claude-cache-keeper/current/statusline/example-statusline.sh",
    "refreshInterval": 30
  }
}
```

Restart your sessions (run `/compact` in them first). That is it.

Just want to try it in one session?

```bash
claude --plugin-dir ~/src/claude-cache-keeper/plugins/cache-keeper
```

> [!IMPORTANT]
> - **Running sessions do not pick the mod up**, not even with `/reload-plugins`:
>   the plugin dir list is read at process start. Restart them.
> - Set the variable in `settings.json`, not in the shell: exported in the
>   environment it was not picked up (Claude Code 2.1.296).
> - Without `"refreshInterval": 30` the status line is not redrawn while the
>   session is idle, and the countdown freezes.

### Requirements

- Claude Code with mods support (tested on 2.1.296 and 2.1.318)
- Linux: the scripts use GNU `date -d`, `tac` and `mv -T`
- `jq` for the status line

## Usage

- Inside a session: `/cache` →
  `cache left ~40 min; context 120k; will compact after 30 more min idle`.
- Is the mod working? It writes no log file. Look for `compact_boundary` in a
  session's transcript about 50 minutes after its last reply, or run `/cache`.
- Already have a status line? Pipe its input through `cache-segment.sh`:

  ```bash
  input=$(cat)
  CACHE=$(echo "$input" | ~/.local/bin/cache-segment.sh)
  echo -e "... $CACHE"
  ```

  It is green, yellow under 10 minutes, and grey once the cache has expired.
- A table of all live sessions with idle time, cache left and context:
  `agents status` from [claude-agents-kit](https://github.com/nazmang/claude-agents-kit).

### Settings

| variable | default | what it does |
|---|---|---|
| `CACHE_KEEPER_AT_MIN` | `50` | compact after N idle minutes |
| `CACHE_KEEPER_MIN_TOKENS` | `60000` | skip smaller contexts: compacting them is not worth it |
| `CACHE_KEEPER_CACHE_MIN` | `60` | prompt cache TTL, minutes |
| `CACHE_KEEPER_TICK_MS` | `60000` | how often the mod checks |
| `CACHE_TTL_MIN` | `60` | cache TTL for the status line |
| `AGENTS_LANG` | from locale | `ru` or `en` for everything a person reads |

With `AGENTS_LANG` unset, the first non-empty of `LC_ALL`, `LC_MESSAGES`,
`LANG` decides: `ru…` means Russian, anything else English. The text the model
sees is never translated. The `CACHE_KEEPER_*` variables are read from
`settings.json` `env`, not from the shell.

If you are on the 5-minute cache TTL (e.g. usage overage), these defaults do
not help: the cache is gone long before minute 50.

## Does it pay off

Measured on one machine with ~10 long-lived sessions (an agent team in tmux plus
project tabs), from the transcripts' `usage` fields only. Cost is in input-token
equivalents: a cache write counts ×2, a cache read ×0.1, input ×1, output ×5,
so models with different prices add up.

| | before the mod | first week (Oct 14–19) | 16 days (Oct 20 – Nov 4) |
|---|---|---|---|
| tokens written to the cache **per cold wake-up** | 547k | 61k | **69k** (−87 %) |
| cost per request | 72k | 24k | **27k** (−63 %) |
| requests per day | 912 | 1480 | 1973 |
| cost per day | 65.9M | 36.2M | 53.0M |

Over the 16 days the mod saved **46.7M equivalents net, 2.9M a day**: about
0.9 of a day of all the work done on that machine in the period.

- **Compactions.** 345 in total, 281 of them by the mod. In 202 cases the
  session later woke up on a cold cache and wrote 60k on average instead of
  213k. The compactions themselves cost 15M equivalents and saved 61.7M.
- **Why the daily cost grew again.** Twice as many requests (new projects) and
  long working sessions in the last 9 days. A single request did not get more
  expensive.
- The per-wake-up line is the clean effect: it barely depends on how much work
  was done.
- Not counted: sessions on other machines driven through Remote Control, whose
  transcripts live on those machines.

To measure your own: compare the average `cache_creation_input_tokens` of the
first request after more than an hour of silence, before and after installing.

## Safety

- `$.session.compact()` refuses while a turn is running; the next tick
  retries. A half-typed draft in the input box is preserved.
- Subagent turns do not reset the idle clock: they have their own cache.
- The cold-cache question only stops prompts typed by a person (terminal or
  phone bridge). Messages from other sessions, task notifications and
  scheduled triggers go through untouched.
- Compaction cannot run inside the submit hook, so "compact then send" drops
  the prompt (it goes back into the input box), compacts, and you press Enter
  again.

## Development

### Releases: never load mods from the tree you edit

Running sessions hot-reload a mod whenever its files change. If settings
point at your working tree, every half-finished save lands in every session at
once. So:

- `./release.sh` refuses uncommitted and untracked changes, runs
  `claude plugin validate` and `claude plugin test` for every plugin, copies
  the committed `plugins/` and `statusline/` to
  `~/.local/share/claude-cache-keeper/releases/<sha>` and switches `current`
  atomically. The last 5 releases are kept.
- `./release.sh --list` shows releases, `./release.sh --rollback <sha>` goes back.
- Settings and `~/.local/bin/cache-segment.sh` point at
  `~/.local/share/claude-cache-keeper/current/...`, never at the repo.
- Develop in a separate worktree (`git worktree add ../claude-cache-keeper-dev -b dev`),
  merge into `main`, then release.

### Tests

```bash
claude --plugin-dir plugins/cache-keeper   # once, interactively: generates .claude-plugin/types
claude plugin validate plugins/cache-keeper && claude plugin test plugins/cache-keeper
```

### Lessons learned

- Do not decide that `/compact` has finished by looking at the screen: an old
  `Compacted` line may still be visible. Check the transcript for a new
  `compact_boundary`.
- A compaction from inside the session beats one typed in from outside: an
  external timer had to guess from the screen whether the input box was empty
  and whether the session was busy. Until October 2026 this repo shipped such
  a systemd timer as a fallback; with the mod installed it fired 4 times on the
  first day and never again in a week, so it was removed.
- Before restarting a session with `--resume`, compact it first, otherwise the
  whole uncompacted tail is written to the cache again.
- The last `usage` in a transcript overstates the context if a compaction came
  after it.
- `$.session.compact()` cannot be called from the `prompt.submit` hook: it
  holds the turn.

## Uninstall

```bash
rm ~/.local/bin/cache-segment.sh
```

Remove `CLAUDE_CODE_PLUGIN_DIRS` and the status line from `settings.json`, then
restart the sessions. `~/.local/share/claude-cache-keeper/` can be deleted
afterwards.

<details>
<summary>Upgrading from an older layout</summary>

Earlier versions also shipped `agents`, the agents-panel and push-guard mods;
they moved to [claude-agents-kit](https://github.com/nazmang/claude-agents-kit).

Remove the old timer if you have one
(`systemctl --user disable --now agents-compact-idle.timer cache-keeper-idle.timer`,
then delete their unit files from `~/.config/systemd/user/` and
`~/.local/bin/cache-keeper-idle`), run `install.sh`, and install
`claude-agents-kit` if you use `agents` or the other mods.

</details>

## License

[MIT](LICENSE)
