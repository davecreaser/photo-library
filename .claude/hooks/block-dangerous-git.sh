#!/bin/bash
# PreToolUse hook: blocks destructive git/gh commands before Claude runs them.
# Agents may push feature branches and open PRs; main is the user's to change.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

block() {
  echo "BLOCKED: '$COMMAND' $1. The user has prevented you from doing this." >&2
  exit 2
}

DANGEROUS_PATTERNS=(
  "git reset --hard"
  "reset --hard"
  "git clean -f"
  "git branch -D"
  "git checkout \."
  "git restore \."
  "gh pr merge"
  "gh repo delete"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    block "matches dangerous pattern '$pattern'"
  fi
done

if echo "$COMMAND" | grep -qE "git push"; then
  # Any force push, including --force-with-lease, -f and +refspec.
  if echo "$COMMAND" | grep -qE -- "(--force|--force-with-lease|(^|[[:space:]])-f([[:space:]]|$)|[[:space:]]\+[^[:space:]]+)"; then
    block "is a force push"
  fi
  # Pushing to main/master by name (main, HEAD:main, refs/heads/main).
  if echo "$COMMAND" | grep -qE "(^|[[:space:]:/])(main|master)([[:space:]]|$)"; then
    block "pushes to main/master; push a feature branch and open a PR instead"
  fi
  # A push that names no branch pushes the current one: block it while on main/master.
  # (Arguments after "push" that aren't options: remote, then refspecs.)
  ARGS=$(echo "$COMMAND" | sed -E 's/.*git push//; s/[;&|].*//' | tr ' ' '\n' | grep -vE '^(-|$)' | wc -l | tr -d ' ')
  BRANCH=$(git -C "${CLAUDE_PROJECT_DIR:-.}" branch --show-current 2>/dev/null)
  if [ "$ARGS" -lt 2 ] && { [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; }; then
    block "would push the current branch ($BRANCH); create a feature branch and open a PR instead"
  fi
fi

exit 0
