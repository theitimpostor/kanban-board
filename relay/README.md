# Linear → GitHub Actions relay

A Cloudflare Worker that receives Linear webhooks and starts the [implement-linear-issue](../.github/workflows/implement-linear-issue.yml) workflow when an issue gets the `claude` label, either when the label is added or when the issue is created with it.

For each request it:

1. Verifies the `Linear-Signature` HMAC over the raw body and rejects webhooks more than a minute old.
2. Ignores anything that isn't an issue gaining the label. It replies 200 so Linear doesn't retry.
3. Sends a `repository_dispatch` event (`linear-issue`) with the issue ID. If GitHub refuses it, the Worker replies 502 so Linear retries.

## Setup

Wrangler needs Node.js 22 or newer.

```bash
cd relay
npm install
npx wrangler deploy
```

Note the Worker URL it prints, then:

1. **GitHub token.** Create a fine-grained personal access token for this repository only, with the **Contents: Read and write** permission.

   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```

2. **Linear webhook.** In Linear, go to *Settings → API → Webhooks → New webhook*. Set the URL to the Worker URL and select the **Issues** data change event. Copy the signing secret shown for the webhook.

   ```bash
   npx wrangler secret put LINEAR_WEBHOOK_SECRET
   ```

The repository and label name are set in `[vars]` in `wrangler.toml`. The label name is matched case-insensitively.

## Debugging

```bash
npx wrangler tail --format pretty
```

Every request logs one JSON line with `outcome` (`accepted`, `ignored` or `rejected`), the `reason`, the HTTP `status`, and the Linear delivery ID, action and issue identifier. A failed dispatch also includes GitHub's error message. Secrets and issue text are never logged. Linear's webhook settings page also lists recent deliveries and their response codes.

Common reasons:

| Reason | Fix |
| --- | --- |
| `signature does not match` | `LINEAR_WEBHOOK_SECRET` isn't this webhook's signing secret |
| `webhookTimestamp is … ms old` | A delivery replayed or delayed by more than a minute; Linear retries with a fresh one |
| `GitHub dispatch failed with 401` / `403` | `GITHUB_TOKEN` is expired or lacks Contents write access |
| `GitHub dispatch failed with 404` | Wrong `GITHUB_REPO`, or the token can't see the repository |
| Accepted, but no workflow run | The workflow isn't on the default branch yet |

## Tests

```bash
npm test
```
