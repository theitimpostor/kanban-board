# Kanban

A small Kanban board you run locally. No dependencies: just Node.js (16+).

## Run

```bash
node server.js
```

Then open http://localhost:3000.

Use another port with `PORT=4000 node server.js`.

## Features

- Columns: add, rename (click the title), delete, drag the header to reorder
- Cards: add, edit title/description/color label, delete, drag within and between columns
- Card history: each card records when it was created, edited and moved between columns (shown in the card dialog, last 100 entries)
- Filter cards by text
- Light and dark mode (follows your system)
- Everything is saved to `data.json` next to `server.js`. Delete that file to reset the board.

## Structure

- `server.js` — HTTP server: REST API under `/api` plus static files
- `public/` — the frontend (plain HTML, CSS and JavaScript)

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/board` | |
| POST | `/api/columns` | `{ title }` |
| PATCH | `/api/columns/:id` | `{ title }` |
| DELETE | `/api/columns/:id` | |
| POST | `/api/columns/:id/move` | `{ index }` |
| POST | `/api/columns/:id/cards` | `{ title, description?, label? }` |
| PATCH | `/api/cards/:id` | `{ title?, description?, label? }` |
| DELETE | `/api/cards/:id` | |
| POST | `/api/cards/:id/move` | `{ columnId, index }` |

Labels: `none`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`.
