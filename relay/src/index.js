// Relays Linear webhooks to GitHub Actions. When an issue gets the trigger label,
// it starts the "Implement Linear issue" workflow with a repository_dispatch event.
// Every request logs one JSON line saying why it was accepted, ignored or rejected:
// watch them with `npm run tail`.

// Linear's recommended limit for how old a delivery may be, to stop replays.
const MAX_AGE_MS = 60_000;

const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    let result;
    try {
      result = await handle(request, env);
    } catch (err) {
      result = { status: 500, outcome: 'error', reason: `unhandled: ${err.message}` };
    }
    console.log(JSON.stringify({ delivery: request.headers.get('Linear-Delivery'), ...result }));
    return new Response(`${result.outcome}\n`, { status: result.status });
  },
};

async function handle(request, env) {
  if (request.method !== 'POST') return reject(405, `method ${request.method} not allowed`);
  if (!env.LINEAR_WEBHOOK_SECRET) return error('LINEAR_WEBHOOK_SECRET is not set');

  // Verify against the raw body: re-serialised JSON would not match the signature.
  const signature = request.headers.get('Linear-Signature');
  if (!signature) return reject(401, 'missing Linear-Signature header');
  if (!/^[0-9a-f]{64}$/i.test(signature)) return reject(401, 'malformed Linear-Signature header');
  const body = await request.text();
  if (!(await verifySignature(body, signature, env.LINEAR_WEBHOOK_SECRET))) {
    return reject(401, 'signature does not match LINEAR_WEBHOOK_SECRET');
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return reject(400, 'body is not valid JSON');
  }

  const age = Date.now() - payload.webhookTimestamp;
  if (!Number.isFinite(age)) return reject(400, 'missing webhookTimestamp');
  if (Math.abs(age) > MAX_AGE_MS) return reject(401, `webhookTimestamp is ${age} ms old (limit ${MAX_AGE_MS})`);

  const context = { type: payload.type, action: payload.action, issue: payload.data?.identifier };
  if (payload.type !== 'Issue') return ignore(`event type ${payload.type} is not Issue`, context);
  if (payload.action !== 'create' && payload.action !== 'update') {
    return ignore(`issue action ${payload.action} is not create or update`, context);
  }
  if (!context.issue) return reject(400, 'issue has no identifier', context);

  const labelName = env.TRIGGER_LABEL || 'claude';
  const label = (payload.data.labels || []).find((l) => l.name?.toLowerCase() === labelName.toLowerCase());
  if (!label) return ignore(`issue does not have the "${labelName}" label`, context);
  // On updates, only fire when this update added the label, not on every later edit.
  if (payload.action === 'update') {
    const before = payload.updatedFrom?.labelIds;
    if (!Array.isArray(before)) return ignore(`labels did not change; "${labelName}" was already on the issue`, context);
    if (before.includes(label.id)) return ignore(`"${labelName}" was already on the issue`, context);
  }

  if (!env.GITHUB_TOKEN) return error('GITHUB_TOKEN is not set', context);
  if (!env.GITHUB_REPO) return error('GITHUB_REPO is not set', context);
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'linear-claude-relay',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ event_type: 'linear-issue', client_payload: { issue: context.issue } }),
  });
  if (!res.ok) {
    // 502 makes Linear retry the delivery later.
    const detail = (await res.text()).slice(0, 300);
    return { status: 502, outcome: 'error', reason: `GitHub dispatch failed: ${res.status} ${detail}`, ...context };
  }
  return { status: 200, outcome: 'accepted', reason: `"${labelName}" label added; dispatched to ${env.GITHUB_REPO}`, ...context };
}

async function verifySignature(body, signatureHex, secret) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const signature = Uint8Array.from(signatureHex.match(/../g), (byte) => parseInt(byte, 16));
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(body));
}

function reject(status, reason, context = {}) {
  return { status, outcome: 'rejected', reason, ...context };
}

// Ignored deliveries are valid but not for us: answer 200 so Linear doesn't retry them.
function ignore(reason, context) {
  return { status: 200, outcome: 'ignored', reason, ...context };
}

function error(reason, context = {}) {
  return { status: 500, outcome: 'error', reason, ...context };
}
