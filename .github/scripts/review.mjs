#!/usr/bin/env node
// Turns the review agent's output into a GitHub pull request review.
//
//   node review.mjs --output claude.json --diff pr.diff --commit <sha> --round 2 --max-rounds 3 [--no-inline]
//
// Prints {"verdict": "approve" | "request_changes", "review": {...}}, where review is the
// request body for POST /repos/{owner}/{repo}/pulls/{number}/reviews. GitHub rejects a
// whole review if one inline comment is on a line outside the diff, so those comments
// are listed in the review body instead.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- claude-review-agent -->';
const MAX_INLINE_COMMENTS = 50;
const MAX_SUMMARY = 8000;
const MAX_COMMENT = 2000;

// Read the review from Claude Code's JSON output. --json-schema puts it in
// structured_output; fall back to a JSON object in the final message.
export function parseAgentOutput(output) {
  let review = output.structured_output;
  if (!review && typeof output.result === 'string') review = jsonFromText(output.result);
  if (!review || typeof review !== 'object') throw new Error('the review agent returned no structured review');
  if (!['approve', 'request_changes'].includes(review.verdict)) {
    throw new Error(`the review agent returned an unknown verdict: ${JSON.stringify(review.verdict)}`);
  }
  if (typeof review.summary !== 'string' || !review.summary.trim()) throw new Error('the review agent returned no summary');
  const comments = (Array.isArray(review.comments) ? review.comments : []).filter(
    (c) => c && typeof c.path === 'string' && c.path && Number.isInteger(c.line) && c.line > 0
      && typeof c.body === 'string' && c.body.trim(),
  );
  return { verdict: review.verdict, summary: review.summary.trim(), comments };
}

function jsonFromText(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// Map each file in a unified diff to the new-file line numbers GitHub accepts
// inline comments on: added and context lines inside a hunk.
export function commentableLines(diff) {
  const files = new Map();
  let file = null;
  let line = 0;
  let inHunk = false;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
    } else if (!inHunk && text.startsWith('+++ ')) {
      const path = unquote(text.slice(4).trimEnd());
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (file && !files.has(file)) files.set(file, new Set());
    } else if (text.startsWith('@@ ')) {
      const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        line = Number(hunk[1]);
        inHunk = true;
      }
    } else if (inHunk && file && (text.startsWith('+') || text.startsWith(' '))) {
      files.get(file).add(line++);
    }
  }
  return files;
}

// Git quotes paths with special characters C-style, with octal escapes for UTF-8 bytes.
function unquote(path) {
  if (!path.startsWith('"')) return path;
  const bytes = [];
  const escapes = { n: 10, t: 9, '"': 34, '\\': 92 };
  for (let i = 1; i < path.length - 1; i++) {
    if (path[i] !== '\\') {
      bytes.push(...Buffer.from(path[i]));
    } else if (/[0-7]/.test(path[i + 1])) {
      bytes.push(parseInt(path.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[path[i + 1]] ?? path.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function clip(text, max) {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function buildReview(agentReview, commentable, { commit, round, maxRounds, inline = true }) {
  const { verdict, summary, comments } = agentReview;
  const inlineComments = [];
  const outsideDiff = [];
  for (const comment of comments) {
    const fits = inline && inlineComments.length < MAX_INLINE_COMMENTS && commentable.get(comment.path)?.has(comment.line);
    (fits ? inlineComments : outsideDiff).push(comment);
  }

  const heading = verdict === 'approve' ? 'Approved' : 'Changes requested';
  const parts = [`${MARKER}\n**Review agent: ${heading}** (round ${round} of ${maxRounds})`, clip(summary, MAX_SUMMARY)];
  if (outsideDiff.length) {
    const title = inline ? 'Comments on lines outside the diff' : 'Comments';
    parts.push(`**${title}:**\n${outsideDiff.map((c) => `- \`${c.path}:${c.line}\`: ${clip(c.body, MAX_COMMENT)}`).join('\n')}`);
  }
  // Reviews by the bot that opened the PR can only be comments: GitHub doesn't let a PR's
  // author approve or request changes, and a bot approval shouldn't count toward merging.
  parts.push('<sub>Posted as a comment by the Claude review agent. Its verdict is shown above and in the PR labels.</sub>');

  return {
    verdict,
    review: {
      commit_id: commit,
      event: 'COMMENT',
      body: parts.join('\n\n'),
      comments: inlineComments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: clip(c.body, MAX_COMMENT) })),
    },
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      diff: { type: 'string' },
      commit: { type: 'string' },
      round: { type: 'string' },
      'max-rounds': { type: 'string' },
      'no-inline': { type: 'boolean', default: false },
    },
  });
  for (const name of ['output', 'diff', 'commit', 'round', 'max-rounds']) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  const agentReview = parseAgentOutput(JSON.parse(readFileSync(values.output, 'utf8')));
  const result = buildReview(agentReview, commentableLines(readFileSync(values.diff, 'utf8')), {
    commit: values.commit,
    round: Number(values.round),
    maxRounds: Number(values['max-rounds']),
    inline: !values['no-inline'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`review.mjs: ${err.message}`);
    process.exit(1);
  }
}
