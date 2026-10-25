#!/usr/bin/env bash
# Runs Claude Code headless in the current directory, shared by the agent workflows.
#
#   run-claude.sh <prompt-file> <output-json> [claude options...]
#
# Uses CLAUDE_MODEL and CLAUDE_MAX_TURNS. On failure it prints Claude's output and
# fails with Claude's own error message, which --output-format json writes to the
# output file rather than to stderr.
set -euo pipefail

prompt=$1
output=$2
shift 2

if claude -p \
  --model "$CLAUDE_MODEL" \
  --max-turns "$CLAUDE_MAX_TURNS" \
  --output-format json \
  "$@" < "$prompt" > "$output"; then
  status=0
else
  status=$?
fi

if [[ $status -ne 0 ]] || ! jq -e '.is_error == false' "$output" >/dev/null 2>&1; then
  # The output can echo issue or PR text, so stop it from running workflow commands.
  token=$(openssl rand -hex 16)
  echo "::group::Claude Code output"
  echo "::stop-commands::$token"
  cat "$output"
  echo "::$token::"
  echo "::endgroup::"
  # subtype is "success" even for errors like a bad API key, so leave it out then.
  reason=$(jq -r '[(.subtype | select(. != "success")), .result] | map(select(. != null and . != "")) | join(": ")' \
    "$output" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//' | cut -c1-500)
  echo "::error::Claude Code failed (exit code $status): ${reason:-no JSON output, see the Claude Code output group above}"
  exit 1
fi
