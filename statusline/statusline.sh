#!/bin/bash
# dsh-crew statusline: prepends the live worker-pool segment (merged from
# all status shards) to a basic statusline. For claude-hud users prefer
# wiring worker-segment.sh via --extra-cmd instead (cli.mjs hud does this).

input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name // .model.id // "?"')
dir=$(basename "$(echo "$input" | jq -r '.workspace.current_dir // "."')")

segment=$("$(dirname "$0")/worker-segment.sh")

line="[$model] $dir"
[ -n "$segment" ] && line="$segment | $line"
echo "$line"
