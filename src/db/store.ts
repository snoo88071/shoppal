import type { Database } from "bun:sqlite";

// ─── Tipi ────────────────────────────────────────────────────────────────────

export interface List {
  id: number;
  name: string;
  /** Cosa ci va in questa lista: Jev la usa come criterio per scegliere la lista giusta. */
  description: string;
  createdAt: string;
  archivedAt: string | null;
}

export type EntryStatus = "open" | "done" | "removed";

export interface Entry {
  id: number;
  listId: number;
  name: string;
  status: EntryStatus;
  createdAt: string;
  updatedAt: string;
}

export type NoteKind = "info" | "avoid";

export interface Note {
  id: number;
  listId: number | null;
  entryId: number | null;
  /** Di cosa parla la nota, es. "pollo". */
  subject: string;
  text: string;
  kind: NoteKind;
  expiresAt: string | null;
  createdAt: string;
  removedAt: string | null;
}

export type EventType =
  | "list_created"
  | "list_updated"
  | "list_archived"
  | "entry_added"
  | "entry_renamed"
  | "entry_moved"
  | "entry_done"
  | "entry_removed"
  | "entry_reopened"
  | "note_added"
  | "note_removed";

export interface Event {
  id: number;
  type: EventType;
  listId: number | null;
  entryId: number | null;
  noteId: number | null;
  /** Il motivo dichiarato dall'utente, es. "ho troppi strumenti a casa". */
  reason: string | null;
  /** Dettagli dell'evento, incluso lo stato precedente, utile per annullare. */
  payload: Record<string, unknown>;
  sourceMessageId: number | null;
  createdAt: string;
}

export interface PendingConfirmation {
  id: number;
  telegramMessageId: number | null;
  payload: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

/** Contesto di un'azione: da quale messaggio arriva e con quale motivo. Finisce nel registro eventi. */
export interface ActionContext {
  reason?: string | null;
  sourceMessageId?: number | null;
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_state" | "duplicate_name",
  ) {
    super(message);
  }
}

// ─── Mappatura righe → oggetti ───────────────────────────────────────────────

type Row = Record<string, any>;

const toList = (r: Row): List => ({
  id: r.id,
  name: r.name,
  description: r.description,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

const toEntry = (r: Row): Entry => ({
  id: r.id,
  listId: r.list_id,
  name: r.name,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toNote = (r: Row): Note => ({
  id: r.id,
  listId: r.list_id,
  entryId: r.entry_id,
  subject: r.subject,
  text: r.text,
  kind: r.kind,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  removedAt: r.removed_at,
});

const toEvent = (r: Row): Event => ({
  id: r.id,
  type: r.type,
  listId: r.list_id,
  entryId: r.entry_id,
  noteId: r.note_id,
  reason: r.reason,
  payload: JSON.parse(r.payload),
  sourceMessageId: r.source_message_id,
  createdAt: r.created_at,
});

const toPending = (r: Row): PendingConfirmation => ({
  id: r.id,
  telegramMessageId: r.telegram_message_id,
  payload: JSON.parse(r.payload),
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

// ─── Store ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Accesso ai dati. Ogni modifica scrive anche il suo evento nel registro, nella stessa transazione:
 * o succedono entrambe le cose o nessuna.
 */
export function createStore(db: Database, opts: { now?: () => Date } = {}) {
  const now = () => (opts.now?.() ?? new Date()).toISOString();

  const tx = <A extends unknown[], R>(fn: (...args: A) => R) => db.transaction(fn) as (...args: A) => R;

  function logEvent(
    type: EventType,
    refs: { listId?: number | null; entryId?: number | null; noteId?: number | null },
    ctx: ActionContext = {},
    payload: Record<string, unknown> = {},
  ): Event {
    const row = db
      .query(
        `INSERT INTO events (type, list_id, entry_id, note_id, reason, payload, source_message_id, created_at)
         VALUES ($type, $listId, $entryId, $noteId, $reason, $payload, $sourceMessageId, $createdAt) RETURNING *`,
      )
      .get({
        type,
        listId: refs.listId ?? null,
        entryId: refs.entryId ?? null,
        noteId: refs.noteId ?? null,
        reason: ctx.reason?.trim() || null,
        payload: JSON.stringify(payload),
        sourceMessageId: ctx.sourceMessageId ?? null,
        createdAt: now(),
      }) as Row;
    return toEvent(row);
  }

  const cleanName = (s: string, what: string) => {
    const v = s.trim().replace(/\s+/g, " ");
    if (!v) throw new StoreError(`${what} vuoto`, "invalid_state");
    return v;
  };

  // ── Liste ──

  const lists = {
    get(id: number): List | undefined {
      const r = db.query("SELECT * FROM lists WHERE id = ?").get(id) as Row | null;
      return r ? toList(r) : undefined;
    },

    /** Liste attive, in ordine di nome. */
    active(): List[] {
      return (db.query("SELECT * FROM lists WHERE archived_at IS NULL ORDER BY name").all() as Row[]).map(toList);
    },

    findByName(name: string): List | undefined {
      const r = db.query("SELECT * FROM lists WHERE archived_at IS NULL AND name = ?").get(name.trim()) as Row | null;
      return r ? toList(r) : undefined;
    },

    create: tx((input: { name: string; description: string }, ctx: ActionContext = {}): List => {
      const name = cleanName(input.name, "Nome lista");
      const description = cleanName(input.description, "Descrizione lista");
      if (lists.findByName(name)) throw new StoreError(`Esiste già una lista "${name}"`, "duplicate_name");
      const list = toList(
        db
          .query("INSERT INTO lists (name, description, created_at) VALUES (?, ?, ?) RETURNING *")
          .get(name, description, now()) as Row,
      );
      logEvent("list_created", { listId: list.id }, ctx, { name, description });
      return list;
    }),

    update: tx((id: number, patch: { name?: string; description?: string }, ctx: ActionContext = {}): List => {
      const before = requireActiveList(id);
      const name = patch.name === undefined ? before.name : cleanName(patch.name, "Nome lista");
      const description =
        patch.description === undefined ? before.description : cleanName(patch.description, "Descrizione lista");
      const clash = lists.findByName(name);
      if (clash && clash.id !== id) throw new StoreError(`Esiste già una lista "${name}"`, "duplicate_name");
      db.query("UPDATE lists SET name = ?, description = ? WHERE id = ?").run(name, description, id);
      logEvent("list_updated", { listId: id }, ctx, {
        before: { name: before.name, description: before.description },
        after: { name, description },
      });
      return lists.get(id)!;
    }),

    archive: tx((id: number, ctx: ActionContext = {}): List => {
      requireActiveList(id);
      db.query("UPDATE lists SET archived_at = ? WHERE id = ?").run(now(), id);
      logEvent("list_archived", { listId: id }, ctx);
      return lists.get(id)!;
    }),
  };

  function requireActiveList(id: number): List {
    const list = lists.get(id);
    if (!list) throw new StoreError(`Lista ${id} inesistente`, "not_found");
    if (list.archivedAt) throw new StoreError(`La lista "${list.name}" è archiviata`, "invalid_state");
    return list;
  }

  // ── Voci ──

  function requireEntry(id: number): Entry {
    const r = db.query("SELECT * FROM entries WHERE id = ?").get(id) as Row | null;
    if (!r) throw new StoreError(`Voce ${id} inesistente`, "not_found");
    return toEntry(r);
  }

  function setStatus(id: number, from: EntryStatus[], to: EntryStatus, type: EventType, ctx: ActionContext): Entry {
    const before = requireEntry(id);
    if (!from.includes(before.status)) {
      throw new StoreError(`"${before.name}" è già in stato ${before.status}`, "invalid_state");
    }
    db.query("UPDATE entries SET status = ?, updated_at = ? WHERE id = ?").run(to, now(), id);
    logEvent(type, { listId: before.listId, entryId: id }, ctx, { from: before.status, to });
    return requireEntry(id);
  }

  const entries = {
    get(id: number): Entry | undefined {
      const r = db.query("SELECT * FROM entries WHERE id = ?").get(id) as Row | null;
      return r ? toEntry(r) : undefined;
    },

    /** Voci aperte di una lista, nell'ordine in cui sono state aggiunte. */
    open(listId: number): Entry[] {
      return (
        db.query("SELECT * FROM entries WHERE list_id = ? AND status = 'open' ORDER BY id").all(listId) as Row[]
      ).map(toEntry);
    },

    /**
     * Le voci che Jev deve conoscere per riconoscere doppioni e riferimenti ("ho comprato il pesto"):
     * tutte quelle aperte, più quelle chiuse (comprate o rimosse) negli ultimi `closedWithinDays` giorni.
     * Solo liste attive; le più recenti prima.
     */
    recent(opts: { closedWithinDays?: number; limit?: number } = {}): Entry[] {
      const since = new Date(Date.parse(now()) - (opts.closedWithinDays ?? 7) * DAY_MS).toISOString();
      return (
        db
          .query(
            `SELECT e.* FROM entries e JOIN lists l ON l.id = e.list_id
             WHERE l.archived_at IS NULL AND (e.status = 'open' OR e.updated_at >= ?)
             ORDER BY (e.status = 'open') DESC, e.updated_at DESC, e.id DESC
             LIMIT ?`,
          )
          .all(since, opts.limit ?? 254) as Row[]
      ).map(toEntry);
    },

    add: tx((input: { listId: number; name: string }, ctx: ActionContext = {}): Entry => {
      requireActiveList(input.listId);
      const name = cleanName(input.name, "Nome voce");
      const t = now();
      const entry = toEntry(
        db
          .query("INSERT INTO entries (list_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *")
          .get(input.listId, name, t, t) as Row,
      );
      logEvent("entry_added", { listId: entry.listId, entryId: entry.id }, ctx, { name });
      return entry;
    }),

    /** Es. "pesto" → "pesto barilla senza aglio". */
    rename: tx((id: number, newName: string, ctx: ActionContext = {}): Entry => {
      const before = requireEntry(id);
      const name = cleanName(newName, "Nome voce");
      db.query("UPDATE entries SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
      logEvent("entry_renamed", { listId: before.listId, entryId: id }, ctx, { from: before.name, to: name });
      return requireEntry(id);
    }),

    /** Es. dalla wishlist al negozio di strumenti musicali. */
    move: tx((id: number, toListId: number, ctx: ActionContext = {}): Entry => {
      const before = requireEntry(id);
      requireActiveList(toListId);
      if (before.listId === toListId) throw new StoreError(`"${before.name}" è già in quella lista`, "invalid_state");
      db.query("UPDATE entries SET list_id = ?, updated_at = ? WHERE id = ?").run(toListId, now(), id);
      logEvent("entry_moved", { listId: toListId, entryId: id }, ctx, { fromListId: before.listId, toListId });
      return requireEntry(id);
    }),

    markDone: tx((id: number, ctx: ActionContext = {}) => setStatus(id, ["open"], "done", "entry_done", ctx)),
    remove: tx((id: number, ctx: ActionContext = {}) => setStatus(id, ["open"], "removed", "entry_removed", ctx)),
    reopen: tx((id: number, ctx: ActionContext = {}) =>
      setStatus(id, ["done", "removed"], "open", "entry_reopened", ctx),
    ),
  };

  // ── Note ──

  const notes = {
    /** Note non rimosse e non scadute. Con `listId`, solo quelle di quella lista più quelle generali. */
    active(filter: { listId?: number; kind?: NoteKind } = {}): Note[] {
      return (
        db
          .query(
            `SELECT * FROM notes
             WHERE removed_at IS NULL AND (expires_at IS NULL OR expires_at > $now)
               AND ($listId IS NULL OR list_id IS NULL OR list_id = $listId)
               AND ($kind IS NULL OR kind = $kind)
             ORDER BY id`,
          )
          .all({ now: now(), listId: filter.listId ?? null, kind: filter.kind ?? null }) as Row[]
      ).map(toNote);
    },

    add: tx(
      (
        input: {
          subject: string;
          text: string;
          kind: NoteKind;
          listId?: number | null;
          entryId?: number | null;
          expiresAt?: string | null;
        },
        ctx: ActionContext = {},
      ): Note => {
        if (input.listId != null) requireActiveList(input.listId);
        if (input.entryId != null) requireEntry(input.entryId);
        const note = toNote(
          db
            .query(
              `INSERT INTO notes (list_id, entry_id, subject, text, kind, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            )
            .get(
              input.listId ?? null,
              input.entryId ?? null,
              cleanName(input.subject, "Oggetto nota"),
              cleanName(input.text, "Testo nota"),
              input.kind,
              input.expiresAt ?? null,
              now(),
            ) as Row,
        );
        logEvent("note_added", { listId: note.listId, entryId: note.entryId, noteId: note.id }, ctx, {
          subject: note.subject,
          text: note.text,
          kind: note.kind,
          expiresAt: note.expiresAt,
        });
        return note;
      },
    ),

    remove: tx((id: number, ctx: ActionContext = {}): Note => {
      const r = db.query("SELECT * FROM notes WHERE id = ?").get(id) as Row | null;
      if (!r) throw new StoreError(`Nota ${id} inesistente`, "not_found");
      const before = toNote(r);
      if (before.removedAt) throw new StoreError("Nota già rimossa", "invalid_state");
      db.query("UPDATE notes SET removed_at = ? WHERE id = ?").run(now(), id);
      logEvent("note_removed", { listId: before.listId, entryId: before.entryId, noteId: id }, ctx);
      return toNote(db.query("SELECT * FROM notes WHERE id = ?").get(id) as Row);
    }),
  };

  // ── Registro eventi ──

  const events = {
    /** Eventi dal più recente, con filtri opzionali. */
    list(filter: { entryId?: number; listId?: number; types?: EventType[]; limit?: number } = {}): Event[] {
      const types = filter.types?.length ? filter.types : null;
      return (
        db
          .query(
            `SELECT * FROM events
             WHERE ($entryId IS NULL OR entry_id = $entryId)
               AND ($listId IS NULL OR list_id = $listId)
               AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
             ORDER BY id DESC LIMIT $limit`,
          )
          .all({
            entryId: filter.entryId ?? null,
            listId: filter.listId ?? null,
            types: types && JSON.stringify(types),
            limit: filter.limit ?? 100,
          }) as Row[]
      ).map(toEvent);
    },
  };

  // ── Conferme in sospeso ──

  const pending = {
    create(payload: unknown, telegramMessageId: number | null = null): PendingConfirmation {
      return toPending(
        db
          .query(
            "INSERT INTO pending_confirmations (telegram_message_id, payload, created_at) VALUES (?, ?, ?) RETURNING *",
          )
          .get(telegramMessageId, JSON.stringify(payload), now()) as Row,
      );
    },

    get(id: number): PendingConfirmation | undefined {
      const r = db.query("SELECT * FROM pending_confirmations WHERE id = ?").get(id) as Row | null;
      return r ? toPending(r) : undefined;
    },

    /** Collega la conferma al messaggio Telegram con i pulsanti, una volta inviato. */
    setTelegramMessage(id: number, telegramMessageId: number) {
      db.query("UPDATE pending_confirmations SET telegram_message_id = ? WHERE id = ?").run(telegramMessageId, id);
    },

    unresolved(): PendingConfirmation[] {
      return (
        db.query("SELECT * FROM pending_confirmations WHERE resolved_at IS NULL ORDER BY id").all() as Row[]
      ).map(toPending);
    },

    /** Segna come risolta. Restituisce false se lo era già (es. pulsante premuto due volte). */
    resolve(id: number): boolean {
      return (
        db
          .query("UPDATE pending_confirmations SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL")
          .run(now(), id).changes > 0
      );
    },
  };

  return { lists, entries, notes, events, pending };
}

export type Store = ReturnType<typeof createStore>;
