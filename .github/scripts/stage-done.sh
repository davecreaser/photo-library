#!/usr/bin/env bash
# Is the agent's stage finished? It is when the stage's label is on the issue.
# Usage: stage-done.sh <execution-file>. Needs STAGE, ISSUE, GITHUB_REPOSITORY, GH_TOKEN.
# Writes done=true|false, denials=N and reason=... to $GITHUB_OUTPUT. Never fails.
set -u
case "$STAGE" in
  idea) want='idea|duplicate|bug' ;;
  spec|revise) want=spec-ready ;;
  *) want=pr-ready ;;
esac
denials=$(jq -r '(if type == "array" then (map(select(.type == "result")) | last) else . end) | .permission_denials_count // 0' "${1:-}" 2>/dev/null || echo "?")
echo "Permission denials: $denials"
echo "denials=$denials" >> "$GITHUB_OUTPUT"
if gh issue view "$ISSUE" --repo "$GITHUB_REPOSITORY" --json labels --jq '.labels[].name' | grep -qxE "$want"; then
  echo "done=true" >> "$GITHUB_OUTPUT"
else
  echo "Stage $STAGE has not added $want yet"
  echo "done=false" >> "$GITHUB_OUTPUT"
  echo "reason=it finished without adding \`$want\` ($denials permission denials)" >> "$GITHUB_OUTPUT"
fi
