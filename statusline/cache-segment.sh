#!/bin/bash
# Prompt-cache countdown for the Claude Code status line.
#
# Usage inside your own statusLine command (it receives the status JSON on stdin):
#   input=$(cat)
#   CACHE=$(echo "$input" | ~/.local/bin/cache-segment.sh)
#   echo -e "... $CACHE"
#
# Prints e.g. "💾 42m" (green), yellow when <=10 min are left, grey "💾 $EXPIRED"
# once the cache is gone: the next request will rewrite the whole context into
# the cache at full price. Counts from the last assistant reply in the transcript.
#
# Language: the languages are the lines of STRINGS below. AGENTS_LANG wins if
# it is one of them; otherwise the language part of the first non-empty of
# LC_ALL, LC_MESSAGES, LANG (uk_UA.UTF-8 -> uk); anything else is English.
# Russian: "💾 42м", "💾 кэш истёк"; Ukrainian: "💾 42хв", "💾 кеш сплив".
#
# Set "statusLine": {"refreshInterval": 30} in settings.json, otherwise the line
# is not redrawn while the session is idle and the countdown freezes.

TTL_MIN=${CACHE_TTL_MIN:-60}
# One line per language: code|minutes unit|expired text. A language is one more line.
STRINGS='en|m|expired
ru|м|кэш истёк
uk|хв|кеш сплив'
row() {  # the STRINGS line for language $1, if any
  case "$1" in ''|*[!a-z]*) return 1 ;; esac
  printf '%s\n' "$STRINGS" | grep -m1 "^$1|"
}
LOC=${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}
LOC=${LOC%%[_.@-]*}
ROW=$(row "$(printf '%s' "${AGENTS_LANG:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')") ||
  ROW=$(row "$(printf '%s' "$LOC" | tr '[:upper:]' '[:lower:]')") || ROW=$(row en)
IFS='|' read -r _ UNIT EXPIRED <<<"$ROW"
GREEN='\033[32m'; YELLOW='\033[33m'; GREY='\033[90m'; RESET='\033[0m'

TRANSCRIPT=$(jq -r '.transcript_path // empty')
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0
LAST=$(tac "$TRANSCRIPT" 2>/dev/null | grep -m1 '"type":"assistant"' \
  | grep -o '"timestamp":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$LAST" ] || exit 0

LEFT=$(( TTL_MIN - ( $(date +%s) - $(date -d "$LAST" +%s) ) / 60 ))
if [ "$LEFT" -le 0 ]; then echo -e "${GREY}💾 $EXPIRED${RESET}"
elif [ "$LEFT" -le 10 ]; then echo -e "${YELLOW}💾 ${LEFT}$UNIT${RESET}"
else echo -e "${GREEN}💾 ${LEFT}$UNIT${RESET}"; fi
