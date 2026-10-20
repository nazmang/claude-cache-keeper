#!/bin/bash
# Links the tools into place. Does not edit settings.json - prints what to add.
set -euo pipefail
REPO=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$HOME/.local/bin}
UNITS=$HOME/.config/systemd/user

CUR=${DEST:-$HOME/.local/share/claude-cache-keeper}/current
"$REPO/release.sh"
mkdir -p "$BIN" "$UNITS"
ln -sfn "$CUR/bin/cache-keeper-idle" "$BIN/cache-keeper-idle"
ln -sfn "$CUR/statusline/cache-segment.sh" "$BIN/cache-segment.sh"
echo "linked: $BIN/cache-keeper-idle, $BIN/cache-segment.sh"

if command -v systemctl >/dev/null && command -v tmux >/dev/null; then
  cp "$REPO"/systemd/cache-keeper-idle.{service,timer} "$UNITS/"
  systemctl --user daemon-reload
  systemctl --user enable --now cache-keeper-idle.timer
  echo "enabled: cache-keeper-idle.timer"
else
  echo "skipped systemd timer (needs systemd and tmux)"
fi

cat <<MSG

Add to ~/.claude/settings.json to load the mod in every new session:

  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "$CUR/plugins/cache-keeper" },
  "statusLine": { "type": "command", "command": "<your status line script>", "refreshInterval": 30 }

Already running sessions pick the mod up only after a restart.
MSG
