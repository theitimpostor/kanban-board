const LABELS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];

const boardEl = document.getElementById('board');
const searchEl = document.getElementById('search');
const toastEl = document.getElementById('toast');
const dialog = document.getElementById('card-dialog');
const cardForm = document.getElementById('card-form');

let board = { columns: [] };
let drag = null; // { type: 'card' | 'column', id }
let editingCardId = null;

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Runs an API call, then reloads the board from the server so the UI always matches what was saved.
async function mutate(method, url, body) {
  try {
    const result = await api(method, url, body);
    board = result && result.columns ? result : await api('GET', '/api/board');
  } catch (err) {
    showToast(err.message);
    board = await api('GET', '/api/board').catch(() => board);
  }
  render();
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toastEl.hidden = true), 3500);
}

// ---------- Rendering ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function render() {
  const focusedAddForm = document.activeElement?.closest?.('.add-card')?.dataset.columnId;
  boardEl.replaceChildren(...board.columns.map(renderColumn), renderAddColumn());
  applyFilter();
  if (focusedAddForm) openAddCard(focusedAddForm);
}

function renderColumn(column) {
  const titleEl = el('h2', { class: 'column-title', title: 'Click to rename', onclick: () => startRename(column, titleEl) }, column.title);

  const header = el('div', { class: 'column-header', draggable: 'true' },
    titleEl,
    el('span', { class: 'count' }, String(column.cards.length)),
    el('button', { class: 'ghost', title: 'Delete column', 'aria-label': `Delete column ${column.title}`, onclick: () => deleteColumn(column) }, '✕'),
  );

  const list = el('ul', { class: 'cards' }, ...column.cards.map(renderCard));

  const columnEl = el('section', { class: 'column', dataset: { id: column.id } },
    header,
    list,
    renderAddCard(column),
  );

  header.addEventListener('dragstart', (e) => {
    if (e.target !== header) return;
    drag = { type: 'column', id: column.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', column.id);
    e.dataTransfer.setDragImage(columnEl, 20, 20);
    requestAnimationFrame(() => columnEl.classList.add('dragging'));
  });
  header.addEventListener('dragend', endDrag);

  columnEl.addEventListener('dragover', (e) => {
    if (drag?.type !== 'card') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    placeCardPlaceholder(list, e.clientY);
  });
  columnEl.addEventListener('drop', (e) => {
    if (drag?.type !== 'card') return;
    e.preventDefault();
    const placeholder = list.querySelector('.placeholder');
    const index = placeholder ? countCardsBefore(placeholder) : column.cards.length;
    const cardId = drag.id;
    endDrag();
    mutate('POST', `/api/cards/${cardId}/move`, { columnId: column.id, index });
  });

  return columnEl;
}

function countCardsBefore(node) {
  let count = 0;
  for (let n = node.previousElementSibling; n; n = n.previousElementSibling) {
    if (n.classList.contains('card') && !n.classList.contains('dragging')) count++;
  }
  return count;
}

function renderCard(card) {
  const cardEl = el('li', {
    class: 'card',
    draggable: 'true',
    tabindex: '0',
    dataset: { id: card.id },
    onclick: () => openCardDialog(card.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCardDialog(card.id); } },
  },
    card.label !== 'none' ? el('div', { class: 'label-bar', style: `background: var(--label-${card.label})` }) : null,
    el('div', { class: 'title' }, card.title),
    card.priority !== 'none' ? el('span', { class: `priority priority-${card.priority}` }, card.priority) : null,
    card.description ? el('div', { class: 'desc-hint' }, '☰ Has description') : null,
  );

  cardEl.addEventListener('dragstart', (e) => {
    drag = { type: 'card', id: card.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
    requestAnimationFrame(() => cardEl.classList.add('dragging'));
  });
  cardEl.addEventListener('dragend', endDrag);

  return cardEl;
}

function placeCardPlaceholder(list, y) {
  document.querySelectorAll('.cards.drop-target').forEach((l) => l !== list && l.classList.remove('drop-target'));
  list.classList.add('drop-target');

  let placeholder = document.querySelector('.placeholder');
  if (!placeholder) placeholder = el('li', { class: 'placeholder' });

  const candidates = [...list.querySelectorAll('.card:not(.dragging):not(.hidden-by-filter)')];
  const after = candidates.find((c) => {
    const box = c.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  if (after) {
    if (placeholder.nextElementSibling !== after) list.insertBefore(placeholder, after);
  } else if (list.lastElementChild !== placeholder) {
    list.appendChild(placeholder);
  }
}

function endDrag() {
  drag = null;
  document.querySelectorAll('.placeholder').forEach((p) => p.remove());
  document.querySelectorAll('.dragging, .drop-target, .drop-before, .drop-after')
    .forEach((n) => n.classList.remove('dragging', 'drop-target', 'drop-before', 'drop-after'));
}

// Column reordering is handled at the board level.
boardEl.addEventListener('dragover', (e) => {
  if (drag?.type !== 'column') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const { target, before } = columnDropTarget(e.clientX);
  document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  if (target) target.classList.add(before ? 'drop-before' : 'drop-after');
});

boardEl.addEventListener('drop', (e) => {
  if (drag?.type !== 'column') return;
  e.preventDefault();
  const { target, before } = columnDropTarget(e.clientX);
  const columnId = drag.id;
  endDrag();
  if (!target) return;
  const others = board.columns.filter((c) => c.id !== columnId);
  let index = others.findIndex((c) => c.id === target.dataset.id);
  if (!before) index++;
  mutate('POST', `/api/columns/${columnId}/move`, { index });
});

function columnDropTarget(x) {
  const columns = [...boardEl.querySelectorAll('.column:not(.dragging)')];
  for (const col of columns) {
    const box = col.getBoundingClientRect();
    if (x < box.left + box.width / 2) return { target: col, before: true };
  }
  return { target: columns[columns.length - 1], before: false };
}

// ---------- Columns ----------

function startRename(column, titleEl) {
  const input = el('input', { value: column.title, maxlength: '100', 'aria-label': 'Column title' });
  let done = false;
  const finish = (saveIt) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (saveIt && title && title !== column.title) mutate('PATCH', `/api/columns/${column.id}`, { title });
    else input.replaceWith(titleEl);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function deleteColumn(column) {
  const n = column.cards.length;
  if (n && !confirm(`Delete "${column.title}" and its ${n} card${n === 1 ? '' : 's'}?`)) return;
  mutate('DELETE', `/api/columns/${column.id}`);
}

function renderAddColumn() {
  const wrap = el('div', { class: 'add-column' });
  const showButton = () => wrap.replaceChildren(el('button', { class: 'ghost', onclick: showForm }, '+ Add column'));
  const showForm = () => {
    const input = el('input', { placeholder: 'Column title', maxlength: '100', 'aria-label': 'New column title' });
    const form = el('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const title = input.value.trim();
        if (title) mutate('POST', '/api/columns', { title });
      },
    },
      input,
      el('div', { class: 'row' },
        el('button', { class: 'primary', type: 'submit' }, 'Add column'),
        el('button', { class: 'ghost', type: 'button', onclick: showButton }, 'Cancel'),
      ),
    );
    input.addEventListener('keydown', (e) => e.key === 'Escape' && showButton());
    wrap.replaceChildren(form);
    input.focus();
  };
  showButton();
  return wrap;
}

// ---------- Adding cards ----------

function renderAddCard(column) {
  const wrap = el('div', { class: 'add-card', dataset: { columnId: column.id } });
  wrap.append(el('button', { class: 'ghost', onclick: () => openAddCard(column.id) }, '+ Add card'));
  return wrap;
}

function openAddCard(columnId) {
  const wrap = boardEl.querySelector(`.add-card[data-column-id="${columnId}"]`);
  if (!wrap) return;
  const close = () => wrap.replaceChildren(el('button', { class: 'ghost', onclick: () => openAddCard(columnId) }, '+ Add card'));
  const input = el('textarea', { rows: '2', placeholder: 'Card title', maxlength: '200', 'aria-label': 'New card title' });
  const submit = () => {
    const title = input.value.trim();
    if (title) mutate('POST', `/api/columns/${columnId}/cards`, { title });
    else input.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') close();
  });
  wrap.replaceChildren(el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    input,
    el('div', { class: 'row' },
      el('button', { class: 'primary', type: 'submit' }, 'Add'),
      el('button', { class: 'ghost', type: 'button', onclick: close }, 'Cancel'),
    ),
  ));
  input.focus();
}

// ---------- Card dialog ----------

const labelOptions = document.getElementById('label-options');
labelOptions.append(...LABELS.map((label) =>
  el('label', { class: 'label-swatch', title: label },
    el('input', { type: 'radio', name: 'label', value: label, 'aria-label': label }),
    el('span', { class: label === 'none' ? 'none' : '', style: label === 'none' ? '' : `background: var(--label-${label})` }),
  ),
));

function findCard(id) {
  for (const column of board.columns) {
    const card = column.cards.find((c) => c.id === id);
    if (card) return { card, column };
  }
  return null;
}

function openCardDialog(id) {
  const found = findCard(id);
  if (!found) return;
  const { card, column } = found;
  editingCardId = id;
  cardForm.title.value = card.title;
  cardForm.description.value = card.description;
  cardForm.querySelector(`input[name="label"][value="${card.label}"]`).checked = true;
  cardForm.priority.value = card.priority;
  document.getElementById('card-meta').textContent =
    `In "${column.title}" · created ${new Date(card.createdAt).toLocaleString()}`;
  dialog.showModal();
  cardForm.title.focus();
}

cardForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = cardForm.title.value.trim();
  if (!title) return cardForm.title.focus();
  dialog.close();
  mutate('PATCH', `/api/cards/${editingCardId}`, {
    title,
    description: cardForm.description.value,
    label: cardForm.label.value,
    priority: cardForm.priority.value,
  });
});

document.getElementById('cancel-card').addEventListener('click', () => dialog.close());

document.getElementById('delete-card').addEventListener('click', () => {
  if (!confirm('Delete this card?')) return;
  dialog.close();
  mutate('DELETE', `/api/cards/${editingCardId}`);
});

// Close when clicking the backdrop.
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

// ---------- Filter ----------

function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  boardEl.querySelectorAll('.card').forEach((cardEl) => {
    const card = findCard(cardEl.dataset.id)?.card;
    const match = !q || card.title.toLowerCase().includes(q) || card.description.toLowerCase().includes(q);
    cardEl.classList.toggle('hidden-by-filter', !match);
  });
}
searchEl.addEventListener('input', applyFilter);

// ---------- Start ----------

api('GET', '/api/board')
  .then((data) => { board = data; render(); })
  .catch((err) => showToast(`Could not load board: ${err.message}`));
