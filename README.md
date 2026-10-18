# Kanban Board

A small Kanban board you run locally. No dependencies: just Node.js (16+).

## Run

```bash
node server.js   # or: npm start
```

Then open http://localhost:3000.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on, e.g. `PORT=4000 node server.js` |
| `DATA_FILE` | `data.json` next to `server.js` | Where the board is saved |

## Features

- Columns: add, rename (click the title), delete, drag the header to reorder
- Cards: add, edit title/description/color label, delete, drag within and between columns
- Keyboard: Enter/Space opens a focused card, Enter saves, Escape cancels
- Filter cards by text
- Light and dark mode (follows your system)
- Everything is saved to `data.json` (or `DATA_FILE`) and is git-ignored. Delete that file to reset
  the board to the starter columns *To Do*, *In Progress* and *Done*.

## Structure

- `server.js` — HTTP server: REST API under `/api` plus static files
- `public/` — the frontend (plain HTML, CSS and JavaScript)
- `linear-relay/` — Cloudflare Worker that forwards Linear webhooks to GitHub (see [Automation](#automation))
- `.github/workflows/linear-claude.yml` — the workflow that runs Claude Code on a Linear issue

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

Limits: column titles up to 100 characters, card titles up to 200, descriptions up to 5000.
`index` is clamped to a valid position; leave it out to append at the end.

Responses are JSON. Creating a column or card returns it with `201`; the `move` endpoints return
the whole board; `DELETE` returns `204`. Errors return `{ "error": "..." }` with `400` (invalid input),
`404` (unknown id) or `413` (body over 1 MB).

## Automation

Add the `claude` label to a Linear issue (or create an issue with it) and Claude Code implements it:

```
Linear webhook ──▶ linear-relay/ (Cloudflare Worker) ──▶ repository_dispatch ──▶ .github/workflows/linear-claude.yml
                   checks signature, filters label                               Claude → PR → Linear comment + status
```

The relay verifies the Linear signature, rejects webhooks older than 60 seconds, and only fires when
an issue is created with the label or the label is added to an existing issue.
The workflow opens a pull request, comments the PR link on the issue and moves it to *In Review*.
Relay logs are available with `npx wrangler tail` (run in `linear-relay/`).

### Setup

1. **GitHub repo**
   - Secrets: `ANTHROPIC_API_KEY`, and `LINEAR_API_KEY` (Linear → Settings → Security & access → Personal API keys).
   - Optional variable `LINEAR_STATE_NAME` if the status should be something other than `In Review`.
   - Settings → Actions → General → tick *Allow GitHub Actions to create and approve pull requests*.
2. **GitHub token for the relay**: a fine-grained personal access token for this repo only, with
   **Contents: Read and write**.
3. **Deploy the relay** (free Cloudflare account; `npx` fetches Wrangler, Cloudflare's CLI):
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

The relay sends `{"event_type": "linear_dev_task", "client_payload": {"issue_id", "title", "description"}}`;
any other sender (Make.com, curl) can start the workflow with the same request.

Anyone who can label issues decides what Claude writes, so review every PR before merging.
