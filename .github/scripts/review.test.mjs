// Tests for review.mjs. Run with: node --test .github/scripts/review.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, buildReview, commentableLines, parseAgentOutput } from './review.mjs';

const DIFF = `diff --git a/server.js b/server.js
index 1111111..2222222 100644
--- a/server.js
+++ b/server.js
@@ -10,4 +10,5 @@ const LABELS = ['none'];
 const a = 1;
-const b = 2;
+const b = 3;
+++counter;
 const c = 4;
@@ -40,2 +41,2 @@ function f() {
-  return 1;
+  return 2;
 }
diff --git a/public/new.js b/public/new.js
new file mode 100644
--- /dev/null
+++ b/public/new.js
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/old.js b/old.js
deleted file mode 100644
--- a/old.js
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git "a/docs/caf\\303\\251 notes.md" "b/docs/caf\\303\\251 notes.md"
--- "a/docs/caf\\303\\251 notes.md"
+++ "b/docs/caf\\303\\251 notes.md"
@@ -1 +1 @@
-old
+new
`;

test('commentableLines maps added and context lines of each file', () => {
  const lines = commentableLines(DIFF);
  assert.deepEqual([...lines.get('server.js')].sort((a, b) => a - b), [10, 11, 12, 13, 41, 42]);
  assert.deepEqual([...lines.get('public/new.js')], [1, 2]);
  assert.equal(lines.has('old.js'), false);
  assert.deepEqual([...lines.get('docs/café notes.md')], [1]);
});

test('an added line starting with "++" is not mistaken for a file header', () => {
  assert.ok(commentableLines(DIFF).get('server.js').has(12));
});

const agent = (overrides = {}) => ({
  structured_output: {
    verdict: 'request_changes',
    summary: 'The counter is never reset.',
    comments: [
      { path: 'server.js', line: 12, body: 'Reset the counter.' },
      { path: 'server.js', line: 30, body: 'Not in the diff.' },
      { path: 'missing.js', line: 1, body: 'File not in the diff.' },
    ],
  },
  ...overrides,
});

test('parseAgentOutput reads structured_output', () => {
  const review = parseAgentOutput(agent());
  assert.equal(review.verdict, 'request_changes');
  assert.equal(review.comments.length, 3);
});

test('parseAgentOutput falls back to JSON in the final message', () => {
  const result = 'Here is my review:\n```json\n{"verdict": "approve", "summary": "Looks good.", "comments": []}\n```';
  assert.deepEqual(parseAgentOutput({ result }), { verdict: 'approve', summary: 'Looks good.', comments: [] });
  assert.equal(parseAgentOutput({ result: 'x {"verdict":"approve","summary":"ok"} y' }).verdict, 'approve');
});

test('parseAgentOutput rejects unusable output', () => {
  assert.throws(() => parseAgentOutput({ result: 'I could not review this.' }), /no structured review/);
  assert.throws(() => parseAgentOutput({ structured_output: { verdict: 'lgtm', summary: 'x' } }), /unknown verdict/);
  assert.throws(() => parseAgentOutput({ structured_output: { verdict: 'approve', summary: ' ' } }), /no summary/);
});

test('parseAgentOutput drops malformed comments', () => {
  const review = parseAgentOutput({
    structured_output: {
      verdict: 'approve',
      summary: 'ok',
      comments: [
        { path: 'a.js', line: 0, body: 'zero' },
        { path: 'a.js', line: 2.5, body: 'fraction' },
        { path: '', line: 1, body: 'no path' },
        { path: 'a.js', line: 1, body: '' },
        null,
        { path: 'a.js', line: 3, body: 'fine' },
      ],
    },
  });
  assert.deepEqual(review.comments, [{ path: 'a.js', line: 3, body: 'fine' }]);
});

const options = { commit: 'abc123', round: 2, maxRounds: 3 };

test('buildReview keeps comments on diff lines inline and lists the rest in the body', () => {
  const { verdict, review } = buildReview(parseAgentOutput(agent()), commentableLines(DIFF), options);
  assert.equal(verdict, 'request_changes');
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.commit_id, 'abc123');
  assert.deepEqual(review.comments, [{ path: 'server.js', line: 12, side: 'RIGHT', body: 'Reset the counter.' }]);
  assert.ok(review.body.startsWith(MARKER));
  assert.match(review.body, /\*\*Review agent: Changes requested\*\* \(round 2 of 3\)/);
  assert.match(review.body, /Comments on lines outside the diff/);
  assert.match(review.body, /`server\.js:30`: Not in the diff\./);
  assert.match(review.body, /`missing\.js:1`: File not in the diff\./);
});

test('buildReview with inline disabled puts every comment in the body', () => {
  const { review } = buildReview(parseAgentOutput(agent()), commentableLines(DIFF), { ...options, inline: false });
  assert.deepEqual(review.comments, []);
  assert.match(review.body, /\*\*Comments:\*\*/);
  assert.match(review.body, /`server\.js:12`: Reset the counter\./);
});

test('buildReview marks approvals', () => {
  const approve = { verdict: 'approve', summary: 'Good.', comments: [] };
  const { verdict, review } = buildReview(approve, commentableLines(DIFF), options);
  assert.equal(verdict, 'approve');
  assert.match(review.body, /\*\*Review agent: Approved\*\*/);
  assert.doesNotMatch(review.body, /Comments/);
});

test('buildReview limits sizes', () => {
  const many = Array.from({ length: 60 }, () => ({ path: 'server.js', line: 12, body: 'x'.repeat(5000) }));
  const { review } = buildReview({ verdict: 'request_changes', summary: 's'.repeat(20000), comments: many }, commentableLines(DIFF), options);
  assert.equal(review.comments.length, 50);
  assert.ok(review.comments.every((c) => c.body.length <= 2001));
  assert.ok(review.body.length < 65536, `body is ${review.body.length} characters`);
});
