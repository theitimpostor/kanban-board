// Zero-dependency Kanban server. Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const LABELS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];

// ---------- Persistence ----------

function defaultBoard() {
  const col = (title, cards) => ({ id: newId(), title, cards });
  const card = (title, description = '', label = 'none', priority = 'none') => ({
    id: newId(), title, description, label, priority, createdAt: new Date().toISOString(),
  });
  return {
    columns: [
      col('To Do', [
        card('Welcome to your board', 'Drag cards between columns. Click a card to edit it.', 'blue', 'high'),
        card('Add a new column', 'Use the "+ Add column" button on the right.'),
      ]),
      col('In Progress', [card('Try dragging me', 'Drop me into "Done".', 'orange')]),
      col('Done', []),
    ],
  };
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read data file, starting fresh:', err.message);
    const board = defaultBoard();
    save(board);
    return board;
  }
}

function save(b) {
  // Write to a temp file then rename, so a crash never leaves a half-written file.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let board = load();

// ---------- Helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function findColumn(id) {
  const column = board.columns.find((c) => c.id === id);
  if (!column) throw new HttpError(404, 'Column not found');
  return column;
}

function findCard(id) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((c) => c.id === id);
    if (index !== -1) return { column, index, card: column.cards[index] };
  }
  throw new HttpError(404, 'Card not found');
}

function cleanText(value, field, { required = false, max = 500 } = {}) {
  if (value === undefined) {
    if (required) throw new HttpError(400, `"${field}" is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new HttpError(400, `"${field}" must be a string`);
  const text = value.trim();
  if (required && !text) throw new HttpError(400, `"${field}" cannot be empty`);
  if (text.length > max) throw new HttpError(400, `"${field}" is too long (max ${max})`);
  return text;
}

function cleanLabel(value) {
  if (value === undefined) return undefined;
  if (!LABELS.includes(value)) throw new HttpError(400, `"label" must be one of ${LABELS.join(', ')}`);
  return value;
}

function cleanPriority(value) {
  if (value === undefined) return undefined;
  if (!PRIORITIES.includes(value)) throw new HttpError(400, `"priority" must be one of ${PRIORITIES.join(', ')}`);
  return value;
}

function clampIndex(index, length) {
  const n = Number.isInteger(index) ? index : length;
  return Math.max(0, Math.min(n, length));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new HttpError(413, 'Body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

// ---------- API routes ----------

const routes = [
  ['GET', /^\/api\/board$/, () => board],

  ['POST', /^\/api\/columns$/, (_, body) => {
    const column = { id: newId(), title: cleanText(body.title, 'title', { required: true, max: 100 }), cards: [] };
    board.columns.push(column);
    return column;
  }],

  ['PATCH', /^\/api\/columns\/(\w+)$/, ([id], body) => {
    const column = findColumn(id);
    column.title = cleanText(body.title, 'title', { required: true, max: 100 });
    return column;
  }],

  ['DELETE', /^\/api\/columns\/(\w+)$/, ([id]) => {
    findColumn(id);
    board.columns = board.columns.filter((c) => c.id !== id);
  }],

  ['POST', /^\/api\/columns\/(\w+)\/move$/, ([id], body) => {
    const column = findColumn(id);
    board.columns.splice(board.columns.indexOf(column), 1);
    board.columns.splice(clampIndex(body.index, board.columns.length), 0, column);
    return board;
  }],

  ['POST', /^\/api\/columns\/(\w+)\/cards$/, ([id], body) => {
    const column = findColumn(id);
    const card = {
      id: newId(),
      title: cleanText(body.title, 'title', { required: true, max: 200 }),
      description: cleanText(body.description, 'description', { max: 5000 }) || '',
      label: cleanLabel(body.label) || 'none',
      priority: cleanPriority(body.priority) || 'none',
      createdAt: new Date().toISOString(),
    };
    column.cards.push(card);
    return card;
  }],

  ['PATCH', /^\/api\/cards\/(\w+)$/, ([id], body) => {
    const { card } = findCard(id);
    const title = cleanText(body.title, 'title', { required: body.title !== undefined, max: 200 });
    const description = cleanText(body.description, 'description', { max: 5000 });
    const label = cleanLabel(body.label);
    const priority = cleanPriority(body.priority);
    if (title !== undefined) card.title = title;
    if (description !== undefined) card.description = description;
    if (label !== undefined) card.label = label;
    if (priority !== undefined) card.priority = priority;
    return card;
  }],

  ['DELETE', /^\/api\/cards\/(\w+)$/, ([id]) => {
    const { column, index } = findCard(id);
    column.cards.splice(index, 1);
  }],

  ['POST', /^\/api\/cards\/(\w+)\/move$/, ([id], body) => {
    const target = findColumn(body.columnId);
    const { column, index, card } = findCard(id);
    column.cards.splice(index, 1);
    target.cards.splice(clampIndex(body.index, target.cards.length), 0, card);
    return board;
  }],
];

async function handleApi(req, res, pathname) {
  for (const [method, pattern, handler] of routes) {
    const match = pathname.match(pattern);
    if (!match || req.method !== method) continue;
    const body = ['POST', 'PATCH'].includes(method) ? await readBody(req) : {};
    const result = handler(match.slice(1), body);
    if (method !== 'GET') save(board);
    return result === undefined ? sendJson(res, 204) : sendJson(res, method === 'POST' && !result.columns ? 201 : 200, result);
  }
  throw new HttpError(404, 'Not found');
}

// ---------- Static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
  fs.readFile(file, (err, content) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else serveStatic(res, pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Kanban board running at http://localhost:${PORT}`);
  console.log(`Data is stored in ${DATA_FILE}`);
});
