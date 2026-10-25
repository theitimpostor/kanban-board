# Linear webhook relay

A Cloudflare Worker that receives Linear webhooks and starts the
[Implement Linear issue](../docs/linear-claude-workflow.md) workflow when an issue gets
the `claude` label. Linear webhooks can't call GitHub Actions directly, so this sits
in between.

For each request it:

1. Checks the `Linear-Signature` header (HMAC-SHA256 of the raw body) against the
   webhook's signing secret.
2. Rejects deliveries whose `webhookTimestamp` is more than 60 seconds off, so a captured
   request can't be replayed.
3. Acts only on `Issue` events where the `claude` label was just added: an issue created
   with it, or an update whose `updatedFrom.labelIds` didn't have it. Later edits to an
   issue that already has the label are ignored.
4. Sends a `repository_dispatch` (`linear-issue`, with the issue identifier) to GitHub.

## Setup

From this folder:

```bash
npm install
```

```bash
npx wrangler login
```

1. Check `GITHUB_REPO` and `TRIGGER_LABEL` in `wrangler.toml`.
2. Create a GitHub fine-grained token limited to that repository, with
   **Contents: Read and write** (needed for `repository_dispatch`). Then:
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
3. Deploy, and note the `*.workers.dev` URL it prints:
   ```bash
   npm run deploy
   ```
4. In Linear: Settings → API → Webhooks → New webhook. Set the URL to the Worker URL,
   tick **Issues** under data change events, and save. Copy the signing secret it shows, then:
   ```bash
   npx wrangler secret put LINEAR_WEBHOOK_SECRET
   ```
5. Create a `claude` label in Linear if there isn't one, and add it to an issue.

## Debugging

```bash
npm run tail
```

Every request logs one JSON line with `outcome`, `reason`, the HTTP `status`, the Linear
`delivery` ID and, once the signature checks out, the event `type`, `action` and `issue`:

```json
{"delivery":"7c1e…","status":200,"outcome":"accepted","reason":"\"claude\" label added; dispatched to theitimpostor/kanban-board","type":"Issue","action":"update","issue":"ENG-123"}
```

| Outcome | Status | Meaning |
| --- | --- | --- |
| `accepted` | 200 | The label was just added and GitHub accepted the dispatch. Check the Actions tab next. |
| `ignored` | 200 | A valid delivery that isn't a label add, such as another edit, another event type or no label. Answered 200 so Linear doesn't retry it. |
| `rejected` | 401 / 400 / 405 | Bad or missing signature, stale timestamp, wrong method or invalid JSON. `signature does not match` usually means `LINEAR_WEBHOOK_SECRET` is wrong. |
| `error` | 500 / 502 | A secret or variable is missing (500), or GitHub refused the dispatch (502, with GitHub's status and message). Linear retries these. |

Linear's webhook settings page also lists recent deliveries and their response codes.

## Tests

```bash
npm test
```

The tests use Node's built-in test runner and need no install.
