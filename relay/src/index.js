// Cloudflare Worker that relays Linear webhooks to GitHub Actions.
//
// When an issue gets the trigger label (env.LABEL_NAME, "claude" by default), it sends a
// repository_dispatch event that starts .github/workflows/implement-linear-issue.yml.
// Every request logs one JSON line saying why it was accepted, ignored or rejected:
// watch them with `npx wrangler tail`.

// Linear recommends rejecting webhooks whose timestamp is more than a minute old.
const MAX_AGE_MS = 60_000;
const DISPATCH_EVENT = 'linear-issue';

export default {
  async fetch(request, env) {
    const log = {
      delivery: request.headers.get('Linear-Delivery'),
      event: request.headers.get('Linear-Event'),
    };
    const respond = (status, outcome, reason, extra = {}) => {
      console.log(JSON.stringify({ outcome, reason, status, ...log, ...extra }));
      return new Response(JSON.stringify({ outcome, reason }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    if (request.method !== 'POST') return respond(405, 'rejected', `method ${request.method} not allowed`);
    if (!env.LINEAR_WEBHOOK_SECRET || !env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return respond(500, 'rejected', 'relay is missing LINEAR_WEBHOOK_SECRET, GITHUB_TOKEN or GITHUB_REPO');
    }

    // Verify the signature over the raw body before trusting anything in it.
    const body = await request.text();
    const signature = request.headers.get('Linear-Signature');
    if (!signature) return respond(401, 'rejected', 'missing Linear-Signature header');
    if (!(await verifySignature(body, signature, env.LINEAR_WEBHOOK_SECRET))) {
      return respond(401, 'rejected', 'signature does not match (check LINEAR_WEBHOOK_SECRET)');
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return respond(400, 'rejected', 'body is not valid JSON');
    }

    const age = Date.now() - Number(payload.webhookTimestamp);
    if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
      return respond(401, 'rejected', `webhookTimestamp is ${Number.isFinite(age) ? `${age} ms old` : 'missing'} (possible replay)`);
    }

    const issue = payload.data || {};
    Object.assign(log, { action: payload.action, issue: issue.identifier });

    // From here on, 200 responses tell Linear the delivery is handled and should not be retried.
    if (payload.type !== 'Issue') return respond(200, 'ignored', `event type is ${payload.type}, not Issue`);
    const labelName = (env.LABEL_NAME || 'claude').toLowerCase();
    const reason = labelAddedReason(payload, labelName);
    if (!reason.added) return respond(200, 'ignored', reason.why);

    const dispatch = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'linear-claude-relay',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: DISPATCH_EVENT, client_payload: { issue_id: issue.id } }),
    });
    if (!dispatch.ok) {
      // 502 makes Linear retry the delivery later.
      const detail = (await dispatch.text()).slice(0, 300);
      return respond(502, 'rejected', `GitHub dispatch failed with ${dispatch.status}`, { github: detail });
    }
    return respond(202, 'accepted', `${reason.why}; started workflow in ${env.GITHUB_REPO}`);
  },
};

// Was the trigger label added by this event? Returns { added, why } for the log.
export function labelAddedReason(payload, labelName) {
  const issue = payload.data || {};
  const label = (issue.labels || []).find((l) => (l.name || '').toLowerCase() === labelName);
  if (payload.action === 'remove') return { added: false, why: 'issue was removed' };
  if (!label) return { added: false, why: `issue does not have the "${labelName}" label` };
  if (payload.action === 'create') return { added: true, why: `issue was created with the "${labelName}" label` };
  if (payload.action !== 'update') return { added: false, why: `action is ${payload.action}` };

  // updatedFrom only carries labelIds when the labels changed in this update.
  const previous = payload.updatedFrom && payload.updatedFrom.labelIds;
  if (!Array.isArray(previous)) return { added: false, why: `labels did not change (already had "${labelName}")` };
  if (previous.includes(label.id)) return { added: false, why: `"${labelName}" label was already on the issue` };
  return { added: true, why: `"${labelName}" label was added` };
}

// Linear signs the raw body with HMAC-SHA256 and sends the hex digest.
// crypto.subtle.verify compares in constant time.
export async function verifySignature(body, signatureHex, secret) {
  if (!/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = new Uint8Array(signatureHex.match(/../g).map((h) => parseInt(h, 16)));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(body));
}
