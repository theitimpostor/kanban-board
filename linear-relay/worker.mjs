// Cloudflare Worker: receives Linear webhooks and starts the "Autonomous Claude
// Linear Developer" GitHub workflow through repository_dispatch.
//
// Fires when an issue is created with the trigger label, or when that label is
// added to an existing issue.
//
// Secrets: LINEAR_WEBHOOK_SECRET, GITHUB_TOKEN
// Vars:    GITHUB_REPO (owner/name), TRIGGER_LABEL (default "claude")

const MAX_AGE_MS = 60_000;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const raw = await request.text();
    const signature = request.headers.get('linear-signature') || '';
    if (!(await validSignature(raw, signature, env.LINEAR_WEBHOOK_SECRET))) {
      return new Response('Invalid signature', { status: 401 });
    }

    const event = JSON.parse(raw);
    if (Math.abs(Date.now() - event.webhookTimestamp) > MAX_AGE_MS) {
      return new Response('Stale webhook', { status: 401 });
    }

    if (!shouldTrigger(event, (env.TRIGGER_LABEL || 'claude').toLowerCase())) {
      return new Response('Ignored', { status: 200 });
    }

    const issue = event.data;
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'linear-relay',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: 'linear_dev_task',
        client_payload: {
          issue_id: issue.identifier,
          title: issue.title,
          // client_payload is limited in size; keep the description bounded.
          description: (issue.description || '').slice(0, 20_000),
        },
      }),
    });

    if (!res.ok) {
      return new Response(`GitHub dispatch failed: ${res.status} ${await res.text()}`, { status: 502 });
    }
    return new Response('Dispatched', { status: 202 });
  },
};

function shouldTrigger(event, label) {
  if (event.type !== 'Issue') return false;

  const labels = event.data.labels || [];
  const match = labels.find((l) => l.name.toLowerCase() === label);
  if (!match) return false;

  if (event.action === 'create') return true;
  if (event.action === 'update') {
    // Only when the label was just added, not on every later edit.
    const before = event.updatedFrom && event.updatedFrom.labelIds;
    return Array.isArray(before) && !before.includes(match.id);
  }
  return false;
}

async function validSignature(body, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
