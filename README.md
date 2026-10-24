# Kanban

A small Kanban board you run locally. No dependencies: just Node.js (16+).

## Run

```bash
node server.js
```

Then open http://localhost:3000.

Use another port with `PORT=4000 node server.js`.

## Features

- Columns: add, rename (click the title), delete, drag the header to reorder
- Cards: add, edit title/description/color label/priority, delete, drag within and between columns
- Filter cards by text
- Light and dark mode (follows your system)
- Everything is saved to `data.json` next to `server.js`. Delete that file to reset the board.

## Structure

- `server.js` — HTTP server: REST API under `/api` plus static files
- `public/` — the frontend (plain HTML, CSS and JavaScript)

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/board` | |
| POST | `/api/columns` | `{ title }` |
| PATCH | `/api/columns/:id` | `{ title }` |
| DELETE | `/api/columns/:id` | |
| POST | `/api/columns/:id/move` | `{ index }` |
| POST | `/api/columns/:id/cards` | `{ title, description?, label?, priority? }` |
| PATCH | `/api/cards/:id` | `{ title?, description?, label?, priority? }` |
| DELETE | `/api/cards/:id` | |
| POST | `/api/cards/:id/move` | `{ columnId, index }` |

Labels: `none`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`.

Priorities: `none`, `low`, `medium`, `high`, `urgent`.

## Linear automation

`.github/workflows/implement-linear-issue.yml` implements a Linear issue with the Claude Code CLI, opens a pull request, comments the PR link on the issue and moves the issue to **In Review**. If a run fails, it comments a link to the run on the issue instead.

**Trigger.** Add the `claude` label to a Linear issue. The Cloudflare Worker in [`relay/`](relay/README.md) receives Linear's webhook, verifies it and sends a `repository_dispatch` event, the same request as:

```bash
curl -X POST https://api.github.com/repos/theitimpostor/kanban-board/dispatches \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d '{"event_type": "linear-issue", "client_payload": {"issue_id": "ENG-123"}}'
```

`issue_id` is the issue's UUID or identifier. The workflow fetches the title and description from Linear itself. You can also start it by hand from the Actions tab.

**Secrets.** `ANTHROPIC_API_KEY` and `LINEAR_API_KEY` (a Linear personal API key).

**Settings.** The model, turn limit and target state name (`REVIEW_STATE`) are in the workflow's `env` block. Under *Settings → Actions → General*, allow GitHub Actions to create pull requests.

### Review and fix agents

After opening a PR, the developer agent starts the **review agent** (`.github/workflows/claude-review.yml`). Claude reviews the PR read-only (it only has the Read, Glob and Grep tools) and posts a review with inline comments.

- **Approved:** the PR gets the `agent-approved` label. A human still merges it.
- **Changes requested:** the **fix agent** (`.github/workflows/claude-fix.yml`) addresses the review, pushes to the PR branch, comments what it changed and starts the review agent again.
- **Still changes requested after 3 rounds** (`MAX_REVIEW_ROUNDS`), or an agent fails or makes no changes: the PR gets the `needs-human` label and a comment, and the agents stop.

Reviews are posted as comments, not approvals: GitHub doesn't let the bot that opened a PR approve it, and a bot approval shouldn't count toward merging. To review an agent PR again, run the review agent from the Actions tab with the PR number. The agents only act on open PRs that the developer agent opened in this repository.

Helper scripts live in `.github/scripts/`. Test the review parser with `node --test .github/scripts/review.test.mjs`.
