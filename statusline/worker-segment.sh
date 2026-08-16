#!/bin/bash
# Compact DSH worker segment for claude-hud --extra-cmd (or any statusline).
# Merges all fresh status shards (~/.config/dsh-crew/status.d/*.json plus
# the legacy status.json during transition) so workers dispatched by ANY
# orchestrator on this machine are visible. Running jobs show tier, elapsed,
# and tokens; idle with history shows "⚙dsh ✓N"; no jobs prints nothing.
# Override the shard dir with $DSH_CREW_STATUS_DIR (mainly for tests).

dir="${DSH_CREW_STATUS_DIR:-$HOME/.config/dsh-crew}"
files=()
for f in "$dir"/status.d/*.json "$dir"/status.json; do
  [ -f "$f" ] && files+=("$f")
done
[ ${#files[@]} -eq 0 ] && exit 0

jq -rs --argjson now "$(date +%s)" '
  def ktok: if . >= 1000 then ((. / 100 | floor) / 10 | tostring) + "k" else tostring end;
  def ts: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  def elapsed: ($now - (.startedAt | ts)) as $s
    | if $s >= 60 then (($s / 60) | floor | tostring) + "m" + (($s % 60) | tostring) + "s"
      else ($s | tostring) + "s" end;
  [.[] | select((.updatedAt | ts) > ($now - 1800)) | .jobs[]] as $all
  | ($all | unique_by(.id)) as $jobs
  | [$jobs[] | select(.status == "running")] as $r
  | ([$jobs[] | select(.status == "done")] | length) as $d
  | ([$jobs[] | select(.status == "failed" or .status == "cancelled")] | length) as $f
  | if (($r | length) + $d + $f) == 0 then "" else
      "⚙dsh"
      + (if ($r | length) > 0 then
          " " + (($r | length) | tostring) + "▶"
          + ($r | map(.tier + " " + elapsed + " " + (.tokens.input | ktok) + "/" + (.tokens.output | ktok)) | join(" · "))
        else "" end)
      + (if $d > 0 then " ✓" + ($d | tostring) else "" end)
      + (if $f > 0 then " ✗" + ($f | tostring) else "" end)
    end' "${files[@]}" 2>/dev/null
