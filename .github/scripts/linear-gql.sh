#!/usr/bin/env bash
# Run a Linear GraphQL request and print its `data` as JSON.
# Usage: linear-gql.sh QUERY [VARIABLES_JSON]
# Needs LINEAR_API_KEY. Exits non-zero on HTTP or GraphQL errors.
set -euo pipefail

query=$1
variables=${2:-'{}'}

response=$(
  jq -n --arg query "$query" --argjson variables "$variables" \
    '{query: $query, variables: $variables}' |
    curl -sS --fail-with-body https://api.linear.app/graphql \
      -H 'Content-Type: application/json' \
      -H "Authorization: $LINEAR_API_KEY" \
      --data @-
)

if jq -e '.errors' <<<"$response" >/dev/null; then
  echo "Linear API error: $(jq -c '.errors' <<<"$response")" >&2
  exit 1
fi

jq '.data' <<<"$response"
