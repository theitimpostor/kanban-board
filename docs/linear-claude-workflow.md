# Linear → Claude Code → pull request

`.github/workflows/linear-implement.yml` takes a Linear issue, has the Claude Code CLI
implement it, opens a pull request, comments the PR link on the issue and moves the
issue to **In Review**. If it fails after the issue was fetched, it comments the run
log link on the issue instead.

## Setup

1. Repository secrets (Settings → Secrets and variables → Actions):
   - `ANTHROPIC_API_KEY`: an Anthropic API key.
   - `LINEAR_API_KEY`: a Linear personal API key (Linear → Settings → Security & access).
     It needs read access to issues plus permission to comment and change status.
2. Settings → Actions → General → Workflow permissions: turn on
   **Allow GitHub Actions to create and approve pull requests**.
3. Each Linear team you trigger from needs a workflow state named `In Review`
   (change `REVIEW_STATE` in the workflow to use another name).

## Triggering

Adding the `claude` label to a Linear issue starts the workflow through the Cloudflare
Worker in [`relay/`](../relay/README.md), which sends a `repository_dispatch` event:

```http
POST https://api.github.com/repos/{owner}/{repo}/dispatches
Authorization: Bearer <token with Contents: write on this repo>
Accept: application/vnd.github+json

{"event_type": "linear-issue", "client_payload": {"issue": "ENG-123"}}
```

`issue` is the issue identifier (`ENG-123`) or its UUID. The relay only needs to send
that; the workflow fetches the title and description from Linear itself. The API returns
`204` with no body; the run shows up in the Actions tab.

To test without the relay: Actions → **Implement Linear issue** → Run workflow, and enter
an issue identifier.

## What it does

| Step | Detail |
| --- | --- |
| Fetch issue | Reads the issue and the team's `In Review` state ID; fails early if either is missing. |
| Implement | Runs `claude -p` on the default branch with the issue as the task. |
| Commit and push | Commits everything Claude changed to `claude/<identifier>` (for example `claude/eng-123`). |
| Pull request | Opens a PR titled `ENG-123: <title>` with Claude's summary as the body. Re-running for the same issue force-pushes the branch and updates the open PR. |
| Linear | Comments the PR link on the issue and moves it to `In Review`. |
| Review | Starts the review agent on the new PR. |

Runs for the same issue are queued, never run in parallel.

## Review and fix agents

Each PR the developer agent opens goes through a review loop:

1. **Review agent** (`claude-review.yml`): Claude reviews the PR read-only (only the Read, Glob
   and Grep tools, no GitHub token) and posts a review with inline comments.
   - **Approve:** labels the PR `agent-approved`. A human still merges it.
   - **Request changes:** starts the fix agent.
2. **Fix agent** (`claude-fix.yml`): Claude addresses the review on the PR's branch, the workflow
   pushes the fixes, comments a summary and starts the review agent again.
3. After **3 review rounds** still requesting changes, the loop stops: the PR gets the
   `needs-human` label and a comment asking a person to take over. The same happens if either
   agent fails, or if the fix agent makes no changes.

Details:

- Reviews are posted as comments, with the verdict in the review text and the labels. GitHub
  doesn't let the account that opened a PR approve it or request changes, and a bot approval
  shouldn't count toward merging anyway.
- Inline comments on lines outside the diff would make GitHub reject the whole review, so they
  are listed in the review body instead.
- The agents only act on open PRs in this repository opened by `github-actions[bot]`, and a
  review and a fix never run on the same PR at once.
- Rounds are counted from the review agent's earlier reviews on the PR, so re-running the review
  agent on a PR that already had 3 just hands it to a human again. To allow more rounds, raise
  `MAX_REVIEW_ROUNDS` in `claude-review.yml`.
- Helper scripts in `.github/scripts/` always come from the default branch, never from the PR.
- The agents start each other with `workflow_dispatch`, because pushes, PRs and reviews made with
  `GITHUB_TOKEN` don't trigger workflows. You can also run either one by hand with a PR number.

## Guardrails

Claude Code only gets the tools in `CLAUDE_ALLOWED_TOOLS`: file reading and editing, plus
`node`, `npm test` and `npm run`. It has no `git`, `gh` or network commands, and the
GitHub token is not stored in the checkout, so it can't push or open PRs itself; the
workflow does that after it finishes. Changes under `.github/` are refused.

Issue text is passed to Claude as a task description, never into a shell command. Anyone who
can write Linear issues and trigger the relay can still steer what code gets proposed, so
PRs from this workflow need the same review as any other.

## Tuning

Set at the top of the workflow:

- `CLAUDE_MODEL`: the model Claude Code uses.
- `CLAUDE_MAX_TURNS`: caps how long a run can go (and what it costs).
- `CLAUDE_ALLOWED_TOOLS`: add the project's own build or test commands here, such as `Bash(make test:*)`.

Each run's turn count and cost are in the job summary.

PRs opened with the default `GITHUB_TOKEN` don't trigger other workflows (such as CI on
`pull_request`). To get CI on them, push and open the PR with a GitHub App token instead.
