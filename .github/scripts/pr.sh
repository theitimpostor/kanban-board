#!/usr/bin/env bash
# Pull request helpers shared by the review and fix agent workflows.
#
#   pr.sh check <pr>                  Print step outputs for an agent PR, or skip=true and a reason
#   pr.sh rounds <pr>                 Print how many reviews the review agent has posted
#   pr.sh history <pr>                Print the review agent's earlier reviews as Markdown
#   pr.sh review <pr> <review-id>     Print one review as Markdown; fails unless the review agent posted it
#   pr.sh label <pr> <add> [remove]   Add a label (creating it if needed), optionally remove another
#   pr.sh unlabel <pr> <name>         Remove a label if the PR has it
#   pr.sh needs-human <pr> <message>  Label the PR needs-human and comment why
#
# Requires GH_TOKEN and GH_REPO.
# shellcheck disable=SC2016  # $vars in single quotes are jq variables, not shell
set -euo pipefail

: "${GH_REPO:?GH_REPO is not set}"

# Reviews carry this marker so rounds can be counted and the fix agent only acts on them.
MARKER='<!-- claude-review-agent -->'
# PRs opened and reviews posted with GITHUB_TOKEN are authored by this account.
BOT='github-actions[bot]'

declare -A LABEL_COLORS=([agent-approved]=0E8A16 [needs-human]=D93F0B)
declare -A LABEL_DESCRIPTIONS=(
  [agent-approved]="Approved by the review agent, waiting for a human"
  [needs-human]="The agents stopped; a human needs to take over"
)

# Only PRs the developer agent opened in this repository are handled.
check() {
  gh api "repos/$GH_REPO/pulls/$1" | jq -r --arg repo "$GH_REPO" --arg bot "$BOT" '
    if .state != "open" then "skip=true\nreason=the pull request is \(.state)"
    elif .head.repo.full_name != $repo then "skip=true\nreason=the pull request comes from a fork"
    elif .user.login != $bot then "skip=true\nreason=the pull request was opened by \(.user.login), not the developer agent"
    else "skip=false\nhead_ref=\(.head.ref)\nhead_sha=\(.head.sha)\nbase_ref=\(.base.ref)"
    end'
}

agent_reviews() {
  gh api --paginate "repos/$GH_REPO/pulls/$1/reviews" \
    | jq -s --arg m "$MARKER" --arg bot "$BOT" \
      '[.[][] | select(.user.login == $bot and ((.body // "") | contains($m)))]'
}

rounds() {
  agent_reviews "$1" | jq 'length'
}

# Markdown for reviews ($1, a JSON array) with their inline comments.
format_reviews() {
  local comments
  comments=$(gh api --paginate "repos/$GH_REPO/pulls/$PR/comments" | jq -s '[.[][]]')
  jq -rn --argjson reviews "$1" --argjson comments "$comments" --arg m "$MARKER" '
    $reviews[] as $r |
    "\($r.body | sub($m; "") | sub("^\\s+"; ""))\n\n" +
    ([$comments[] | select(.pull_request_review_id == $r.id)
      | "- `\(.path):\(.line // .original_line)`: \(.body)"] | join("\n")) + "\n"'
}

history() {
  format_reviews "$(agent_reviews "$1")"
}

review() {
  local id=$1 review
  [[ "$id" =~ ^[0-9]+$ ]] || { echo "Invalid review ID: $id" >&2; exit 2; }
  review=$(gh api "repos/$GH_REPO/pulls/$PR/reviews/$id")
  # Anyone can write the marker, so check the author too.
  if ! jq -e --arg m "$MARKER" --arg bot "$BOT" '.user.login == $bot and ((.body // "") | contains($m))' \
    <<<"$review" >/dev/null; then
    echo "Review $id on PR #$PR was not posted by the review agent." >&2
    exit 1
  fi
  format_reviews "[$review]"
}

label() {
  local add=$1 remove=${2:-}
  gh label create "$add" --color "${LABEL_COLORS[$add]}" --description "${LABEL_DESCRIPTIONS[$add]}" --force >/dev/null
  gh api "repos/$GH_REPO/issues/$PR/labels" -f "labels[]=$add" >/dev/null
  if [[ -n "$remove" ]]; then unlabel "$remove"; fi
}

unlabel() {
  gh api -X DELETE "repos/$GH_REPO/issues/$PR/labels/$1" >/dev/null 2>&1 || true
}

needs_human() {
  label needs-human agent-approved
  printf '%s\n\nThe agents have stopped working on this pull request. A human needs to take over.\n' "$1" \
    | gh pr comment "$PR" --body-file -
  echo "::warning::Handed PR #$PR to a human: $1"
}

PR=${2:-}
if [[ ! "$PR" =~ ^[0-9]+$ ]]; then
  echo "Invalid pull request number: $PR" >&2
  exit 2
fi

case "$1" in
  check)       check "$PR" ;;
  rounds)      rounds "$PR" ;;
  history)     history "$PR" ;;
  review)      review "$3" ;;
  label)       label "$3" "${4:-}" ;;
  unlabel)     unlabel "$3" ;;
  needs-human) needs_human "$3" ;;
  *) echo "usage: $0 {check|rounds|history|review|label|unlabel|needs-human} <pr> ..." >&2; exit 2 ;;
esac
