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
# Language: AGENTS_LANG=ru|en, otherwise the first non-empty of LC_ALL,
# LC_MESSAGES, LANG ("ru..." = Russian, anything else English). Russian:
# "💾 42м", "💾 кэш истёк".
#
# Set "statusLine": {"refreshInterval": 30} in settings.json, otherwise the line
# is not redrawn while the session is idle and the countdown freezes.

TTL_MIN=${CACHE_TTL_MIN:-60}
case "${AGENTS_LANG:-}" in
  ru|en) L=$AGENTS_LANG ;;
  *) case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in ru*) L=ru ;; *) L=en ;; esac ;;
esac
if [ "$L" = ru ]; then UNIT=м; EXPIRED="кэш истёк"; else UNIT=m; EXPIRED=expired; fi
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
