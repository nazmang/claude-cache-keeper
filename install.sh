#!/bin/bash
# Links the tools into place. Does not edit settings.json - prints what to add.
set -euo pipefail
REPO=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$HOME/.local/bin}

CUR=${DEST:-$HOME/.local/share/claude-cache-keeper}/current
"$REPO/release.sh"
mkdir -p "$BIN"
ln -sfn "$CUR/statusline/cache-segment.sh" "$BIN/cache-segment.sh"
echo "linked: $BIN/cache-segment.sh"

cat <<MSG

Add to ~/.claude/settings.json to load the mod in every new session:

  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "$CUR/plugins/cache-keeper" },
  "statusLine": { "type": "command", "command": "<your status line script>", "refreshInterval": 30 }

Already running sessions pick the mod up only after a restart.
MSG
