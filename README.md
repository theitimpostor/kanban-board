# Kanban Board

A small Kanban board you run locally. No dependencies: just Node.js (16+).

## Run

```bash
node server.js   # or: npm start
```

Then open http://localhost:3000.

Environment variables:

- `PORT` — port to listen on (default `3000`), e.g. `PORT=4000 node server.js`
- `DATA_FILE` — where the board is saved (default `data.json` next to `server.js`)

## Features

- Columns: add, rename (click the title), delete, drag the header to reorder
- Cards: add, edit title/description/color label, delete, drag within and between columns
- Filter cards by text
- Light and dark mode (follows your system)
- Everything is saved to `data.json` (or `DATA_FILE`). Delete that file to reset the board to the sample columns.

## Structure

- `server.js` — HTTP server: REST API under `/api` plus static files
- `public/` — the frontend (plain HTML, CSS and JavaScript)
- `linear-relay/` — Cloudflare Worker that forwards Linear webhooks to GitHub (see [Automation](#automation))

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/board` | |
| POST | `/api/columns` | `{ title }` |
| PATCH | `/api/columns/:id` | `{ title }` |
| DELETE | `/api/columns/:id` | |
| POST | `/api/columns/:id/move` | `{ index }` |
| POST | `/api/columns/:id/cards` | `{ title, description?, label? }` |
| PATCH | `/api/cards/:id` | `{ title?, description?, label? }` |
| DELETE | `/api/cards/:id` | |
| POST | `/api/cards/:id/move` | `{ columnId, index }` |

Labels: `none`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`.

Requests and responses are JSON. Creating a column or card returns it with `201`; the `move`
endpoints return the whole board; `DELETE` returns `204`. Errors return `{ "error": "message" }`
with `400` (invalid input), `404` (unknown id or route) or `500`. Limits: column titles 100
characters, card titles 200, descriptions 5000.

## Automation

Add the `claude` label to a Linear issue (or create an issue with it) and Claude Code implements it:

```
Linear webhook ──▶ linear-relay/ (Cloudflare Worker) ──▶ repository_dispatch ──▶ .github/workflows/linear-claude.yml
                   checks signature, filters label                               Claude → PR → Linear comment + status
```

The workflow runs Claude on a `claude/linear-<issue id>` branch, opens a pull request, comments the PR
link on the issue and moves it to *In Review*. Changes Claude makes under `.github/` are discarded.
Triggering the same issue again replaces the earlier attempt on its branch and reuses the open PR.

### Setup

1. **GitHub repo**
   - Secrets: `ANTHROPIC_API_KEY`, and `LINEAR_API_KEY` (Linear → Settings → Security & access → Personal API keys).
   - Optional variable `LINEAR_STATE_NAME` if the status should be something other than `In Review`.
   - Settings → Actions → General → tick *Allow GitHub Actions to create and approve pull requests*.
2. **GitHub token for the relay**: a fine-grained personal access token for this repo only, with
   **Contents: Read and write**.
3. **Deploy the relay** (free Cloudflare account; `npx` fetches Wrangler, Cloudflare's CLI).
   If you forked this repo, first set `GITHUB_REPO` in `linear-relay/wrangler.toml` to your `owner/name`.
   ```bash
   cd linear-relay
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN
   ```
   Note the `*.workers.dev` URL that `deploy` prints.
4. **Linear**: Settings → API → Webhooks → New webhook. URL = the worker URL, events = **Issues**,
   pick the team. Then store its signing secret:
   ```bash
   npx wrangler secret put LINEAR_WEBHOOK_SECRET
   ```
5. Create a `claude` label in Linear (or change `TRIGGER_LABEL` in `linear-relay/wrangler.toml`).

The relay only fires when an issue is created with the label or the label is newly added, and it
rejects webhooks with a bad signature or older than 60 seconds. Run `npx wrangler tail` in
`linear-relay/` to see why a webhook was accepted or ignored.

The relay sends `{"event_type": "linear_dev_task", "client_payload": {"issue_id", "title", "description"}}`;
any other sender (Make.com, curl) can start the workflow with the same request.

Anyone who can label issues decides what Claude writes, so review every PR before merging.
