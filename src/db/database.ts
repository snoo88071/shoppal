import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Migrazioni in ordine. La versione applicata è salvata in `PRAGMA user_version`:
 * per cambiare lo schema si aggiunge un elemento in fondo, senza mai modificare quelli esistenti.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE lists (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL COLLATE NOCASE,
    description TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    archived_at TEXT
  );
  -- Il nome è unico solo tra le liste attive: una lista archiviata non blocca il nome.
  CREATE UNIQUE INDEX lists_active_name ON lists (name) WHERE archived_at IS NULL;

  CREATE TABLE entries (
    id         INTEGER PRIMARY KEY,
    list_id    INTEGER NOT NULL REFERENCES lists (id),
    name       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'removed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX entries_list_status ON entries (list_id, status);
  CREATE INDEX entries_updated ON entries (updated_at);

  CREATE TABLE notes (
    id         INTEGER PRIMARY KEY,
    list_id    INTEGER REFERENCES lists (id),
    entry_id   INTEGER REFERENCES entries (id),
    subject    TEXT NOT NULL,
    text       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('info', 'avoid')),
    expires_at TEXT,
    created_at TEXT NOT NULL,
    removed_at TEXT
  );

  CREATE TABLE events (
    id                INTEGER PRIMARY KEY,
    type              TEXT NOT NULL,
    list_id           INTEGER REFERENCES lists (id),
    entry_id          INTEGER REFERENCES entries (id),
    note_id           INTEGER REFERENCES notes (id),
    reason            TEXT,
    payload           TEXT NOT NULL DEFAULT '{}',
    source_message_id INTEGER,
    created_at        TEXT NOT NULL
  );
  CREATE INDEX events_entry ON events (entry_id);
  CREATE INDEX events_created ON events (created_at);

  CREATE TABLE pending_confirmations (
    id                  INTEGER PRIMARY KEY,
    telegram_message_id INTEGER,
    payload             TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    resolved_at         TEXT
  );
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number };
  db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v++) db.run(MIGRATIONS[v]!);
    // PRAGMA non accetta parametri: il valore è un intero calcolato da noi, quindi è sicuro interpolarlo.
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  })();
}
