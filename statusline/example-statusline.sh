#!/bin/bash
# Minimal status line: model, directory and the cache countdown.
input=$(cat)
MODEL=$(echo "$input" | jq -r '.model.display_name')
DIR=$(echo "$input" | jq -r '.workspace.current_dir')
CACHE=$(echo "$input" | "$(dirname "$0")/cache-segment.sh")
echo -e "[$MODEL] ${DIR##*/}${CACHE:+ | $CACHE}"
