import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';
import worker from '../src/index.js';

globalThis.crypto ??= webcrypto;

const SECRET = 'test-secret';
const env = {
  LINEAR_WEBHOOK_SECRET: SECRET,
  GITHUB_TOKEN: 'gh-test-token',
  GITHUB_REPO: 'acme/app',
  TRIGGER_LABEL: 'claude',
};
const CLAUDE = { id: 'label-claude', name: 'Claude' };
const BUG = { id: 'label-bug', name: 'Bug' };

let dispatches;
let logs;
let githubStatus;
const realFetch = globalThis.fetch;
const realLog = console.log;

beforeEach(() => {
  dispatches = [];
  logs = [];
  githubStatus = 204;
  globalThis.fetch = async (url, init) => {
    dispatches.push({ url, init, body: JSON.parse(init.body) });
    return new Response(githubStatus === 204 ? null : 'Bad credentials', { status: githubStatus });
  };
  console.log = (line) => logs.push(JSON.parse(line));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

function issueEvent(overrides = {}) {
  return {
    type: 'Issue',
    action: 'update',
    webhookTimestamp: Date.now(),
    data: { id: 'uuid-1', identifier: 'ENG-7', labels: [BUG, CLAUDE] },
    updatedFrom: { labelIds: [BUG.id] },
    ...overrides,
  };
}

async function send(payload, { secret = SECRET, signature, method = 'POST' } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = { 'Linear-Delivery': 'delivery-1' };
  // signature: null sends no header; undefined signs the body with `secret`.
  const sig = signature === undefined ? createHmac('sha256', secret).update(body).digest('hex') : signature;
  if (sig !== null) headers['Linear-Signature'] = sig;
  const res = await worker.fetch(
    new Request('https://relay.example/', { method, headers, body: method === 'POST' ? body : undefined }),
    env,
  );
  return { status: res.status, log: logs.at(-1) };
}

test('dispatches when an update adds the label', async () => {
  const { status, log } = await send(issueEvent());
  assert.equal(status, 200);
  assert.equal(log.outcome, 'accepted');
  assert.equal(log.issue, 'ENG-7');
  assert.equal(log.delivery, 'delivery-1');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].url, 'https://api.github.com/repos/acme/app/dispatches');
  assert.equal(dispatches[0].init.headers.Authorization, 'Bearer gh-test-token');
  assert.deepEqual(dispatches[0].body, { event_type: 'linear-issue', client_payload: { issue: 'ENG-7' } });
});

test('dispatches when an issue is created with the label', async () => {
  const { status, log } = await send(issueEvent({ action: 'create', updatedFrom: undefined }));
  assert.equal(status, 200);
  assert.equal(log.outcome, 'accepted');
  assert.equal(dispatches.length, 1);
});

test('rejects a wrong signature', async () => {
  const { status, log } = await send(issueEvent(), { secret: 'other-secret' });
  assert.equal(status, 401);
  assert.equal(log.outcome, 'rejected');
  assert.match(log.reason, /signature does not match/);
  assert.equal(dispatches.length, 0);
});

test('rejects a missing or malformed signature', async () => {
  assert.match((await send(issueEvent(), { signature: null })).log.reason, /missing Linear-Signature/);
  assert.match((await send(issueEvent(), { signature: 'zz' })).log.reason, /malformed/);
  assert.equal(dispatches.length, 0);
});

test('rejects a body changed after signing', async () => {
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(issueEvent())).digest('hex');
  const tampered = issueEvent({ data: { identifier: 'ENG-666', labels: [CLAUDE] } });
  const { status } = await send(tampered, { signature });
  assert.equal(status, 401);
  assert.equal(dispatches.length, 0);
});

test('rejects stale deliveries', async () => {
  const { status, log } = await send(issueEvent({ webhookTimestamp: Date.now() - 5 * 60_000 }));
  assert.equal(status, 401);
  assert.match(log.reason, /webhookTimestamp is \d+ ms old/);
  assert.equal(dispatches.length, 0);
});

test('ignores updates where the label was already there', async () => {
  const already = await send(issueEvent({ updatedFrom: { labelIds: [BUG.id, CLAUDE.id] } }));
  assert.equal(already.status, 200);
  assert.equal(already.log.outcome, 'ignored');
  assert.match(already.log.reason, /already on the issue/);

  const otherEdit = await send(issueEvent({ updatedFrom: { title: 'Old title' } }));
  assert.equal(otherEdit.log.outcome, 'ignored');
  assert.match(otherEdit.log.reason, /labels did not change/);
  assert.equal(dispatches.length, 0);
});

test('ignores issues without the label, other event types and removals', async () => {
  assert.match((await send(issueEvent({ data: { identifier: 'ENG-7', labels: [BUG] } }))).log.reason, /does not have the "claude" label/);
  assert.match((await send(issueEvent({ type: 'Comment' }))).log.reason, /event type Comment/);
  assert.match((await send(issueEvent({ action: 'remove' }))).log.reason, /action remove/);
  assert.equal(dispatches.length, 0);
});

test('returns 502 so Linear retries when GitHub rejects the dispatch', async () => {
  githubStatus = 401;
  const { status, log } = await send(issueEvent());
  assert.equal(status, 502);
  assert.equal(log.outcome, 'error');
  assert.match(log.reason, /GitHub dispatch failed: 401 Bad credentials/);
});

test('rejects non-POST requests and invalid JSON', async () => {
  assert.equal((await send('', { method: 'GET' })).status, 405);
  const { status, log } = await send('not json');
  assert.equal(status, 400);
  assert.match(log.reason, /not valid JSON/);
});
