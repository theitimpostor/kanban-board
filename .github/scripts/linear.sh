#!/usr/bin/env bash
# Minimal Linear GraphQL client used by the implement-linear-issue workflow.
#
#   linear.sh get-issue <id-or-identifier>     Print the issue as JSON
#   linear.sh comment   <issue-id> <body-file> Add a Markdown comment to the issue
#   linear.sh set-state <issue-id> <state>     Move the issue to the named workflow state
#
# Requires LINEAR_API_KEY (a personal API key or OAuth token), curl and jq.
# shellcheck disable=SC2016  # $vars in single quotes are GraphQL variables, not shell
set -euo pipefail

API_URL="https://api.linear.app/graphql"

: "${LINEAR_API_KEY:?LINEAR_API_KEY is not set}"

# gql <query> <variables-json> -> prints .data, fails on GraphQL errors.
# Variables are always built with jq so issue text can never break the request.
gql() {
  local payload response
  payload=$(jq -n --arg query "$1" --argjson variables "$2" '{query: $query, variables: $variables}')
  response=$(curl -sS --fail-with-body -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: $LINEAR_API_KEY" \
    --data "$payload")
  if jq -e '.errors' <<<"$response" >/dev/null; then
    echo "Linear API error: $(jq -c '.errors' <<<"$response")" >&2
    exit 1
  fi
  jq '.data' <<<"$response"
}

get_issue() {
  gql 'query($id: String!) {
    issue(id: $id) {
      id identifier title description url branchName
      team { key }
    }
  }' "$(jq -n --arg id "$1" '{id: $id}')" | jq -e '.issue'
}

comment() {
  gql 'mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }' "$(jq -n --arg issueId "$1" --rawfile body "$2" '{issueId: $issueId, body: $body}')" \
    | jq -e '.commentCreate.success' >/dev/null
}

set_state() {
  local states state_id
  states=$(gql 'query($id: String!) {
    issue(id: $id) { team { states(first: 100) { nodes { id name } } } }
  }' "$(jq -n --arg id "$1" '{id: $id}')")
  state_id=$(jq -r --arg name "$2" \
    '.issue.team.states.nodes[] | select((.name | ascii_downcase) == ($name | ascii_downcase)) | .id' \
    <<<"$states" | head -n1)
  if [[ -z "$state_id" ]]; then
    echo "No workflow state named \"$2\" in this issue's team." >&2
    echo "Available: $(jq -r '[.issue.team.states.nodes[].name] | join(", ")' <<<"$states")" >&2
    exit 1
  fi
  gql 'mutation($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }' "$(jq -n --arg id "$1" --arg stateId "$state_id" '{id: $id, stateId: $stateId}')" \
    | jq -e '.issueUpdate.success' >/dev/null
}

case "${1:-}" in
  get-issue) get_issue "$2" ;;
  comment)   comment "$2" "$3" ;;
  set-state) set_state "$2" "$3" ;;
  *) echo "usage: $0 {get-issue|comment|set-state} ..." >&2; exit 2 ;;
esac
