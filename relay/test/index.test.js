import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';
import worker from '../src/index.js';

// Node 18 has no global crypto; Workers and newer Node do.
globalThis.crypto ??= webcrypto;

const env = {
  LINEAR_WEBHOOK_SECRET: 'test-secret',
  GITHUB_TOKEN: 'gh-token',
  GITHUB_REPO: 'owner/repo',
  LABEL_NAME: 'claude',
};

const LABEL = { id: 'label-claude', name: 'Claude' };

function issueEvent(overrides = {}) {
  return {
    type: 'Issue',
    action: 'update',
    webhookTimestamp: Date.now(),
    data: { id: 'issue-uuid', identifier: 'ENG-1', labels: [LABEL] },
    updatedFrom: { labelIds: [] },
    ...overrides,
  };
}

function sign(body, secret = env.LINEAR_WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function webhook(payload, { signature, method = 'POST' } = {}) {
  const body = JSON.stringify(payload);
  return new Request('https://relay.example/', {
    method,
    headers: { 'Linear-Signature': signature ?? sign(body), 'Linear-Event': payload.type, 'Linear-Delivery': 'd-1' },
    body: method === 'POST' ? body : undefined,
  });
}

let dispatches, logs, realFetch, realLog, githubStatus;

beforeEach(() => {
  dispatches = [];
  logs = [];
  githubStatus = 204;
  realFetch = globalThis.fetch;
  realLog = console.log;
  globalThis.fetch = async (url, init) => {
    dispatches.push({ url, init });
    return new Response(githubStatus === 204 ? null : 'Bad credentials', { status: githubStatus });
  };
  console.log = (line) => logs.push(JSON.parse(line));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

async function run(request) {
  const response = await worker.fetch(request, env);
  assert.equal(logs.length, 1, 'each request logs exactly one line');
  return { status: response.status, log: logs[0] };
}

test('dispatches the workflow when the label is added', async () => {
  const { status, log } = await run(webhook(issueEvent()));
  assert.equal(status, 202);
  assert.equal(log.outcome, 'accepted');
  assert.equal(log.issue, 'ENG-1');
  assert.equal(log.delivery, 'd-1');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].url, 'https://api.github.com/repos/owner/repo/dispatches');
  assert.equal(dispatches[0].init.headers.Authorization, 'Bearer gh-token');
  assert.deepEqual(JSON.parse(dispatches[0].init.body), {
    event_type: 'linear-issue',
    client_payload: { issue_id: 'issue-uuid' },
  });
});

test('dispatches when an issue is created with the label', async () => {
  const { status } = await run(webhook(issueEvent({ action: 'create', updatedFrom: undefined })));
  assert.equal(status, 202);
  assert.equal(dispatches.length, 1);
});

test('ignores updates that did not add the label', async (t) => {
  const cases = {
    'labels unchanged': issueEvent({ updatedFrom: { title: 'old title' } }),
    'label already there': issueEvent({ updatedFrom: { labelIds: [LABEL.id] } }),
    'other label only': issueEvent({ data: { id: 'x', identifier: 'ENG-2', labels: [{ id: 'l2', name: 'bug' }] } }),
    'issue removed': issueEvent({ action: 'remove' }),
    'not an issue': issueEvent({ type: 'Comment' }),
  };
  for (const [name, payload] of Object.entries(cases)) {
    await t.test(name, async () => {
      logs = [];
      const { status, log } = await run(webhook(payload));
      assert.equal(status, 200);
      assert.equal(log.outcome, 'ignored');
      assert.ok(log.reason);
    });
  }
  assert.equal(dispatches.length, 0);
});

test('rejects requests that fail verification', async (t) => {
  const cases = {
    'wrong method': [webhook(issueEvent(), { method: 'GET' }), 405],
    'missing signature': [webhook(issueEvent(), { signature: '' }), 401],
    'wrong secret': [webhook(issueEvent(), { signature: sign('{}', 'other-secret') }), 401],
    'not hex': [webhook(issueEvent(), { signature: 'zz' }), 401],
    'stale timestamp': [webhook(issueEvent({ webhookTimestamp: Date.now() - 5 * 60_000 })), 401],
    'missing timestamp': [webhook(issueEvent({ webhookTimestamp: undefined })), 401],
  };
  for (const [name, [request, expected]] of Object.entries(cases)) {
    await t.test(name, async () => {
      logs = [];
      const { status, log } = await run(request);
      assert.equal(status, expected);
      assert.equal(log.outcome, 'rejected');
    });
  }
  assert.equal(dispatches.length, 0);
});

test('a body changed after signing is rejected', async () => {
  const body = JSON.stringify(issueEvent());
  const request = new Request('https://relay.example/', {
    method: 'POST',
    headers: { 'Linear-Signature': sign(body) },
    body: body.replace('issue-uuid', 'other-uuid'),
  });
  const { status } = await run(request);
  assert.equal(status, 401);
});

test('returns 502 so Linear retries when GitHub refuses the dispatch', async () => {
  githubStatus = 401;
  const { status, log } = await run(webhook(issueEvent()));
  assert.equal(status, 502);
  assert.equal(log.outcome, 'rejected');
  assert.match(log.reason, /401/);
  assert.equal(log.github, 'Bad credentials');
});

test('logs never contain secrets', async () => {
  githubStatus = 401;
  await run(webhook(issueEvent()));
  const line = JSON.stringify(logs);
  assert.ok(!line.includes(env.GITHUB_TOKEN));
  assert.ok(!line.includes(env.LINEAR_WEBHOOK_SECRET));
});
