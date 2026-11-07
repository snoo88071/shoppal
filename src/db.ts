import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Item {
  id: number;
  name: string;
  quantity: string | null;
  notes: string | null;
  category: string;
  /** Confidence di Jev sulla categoria (null se assegnata a mano o senza AI). */
  categoryConfidence: number | null;
  purchased: boolean;
  createdAt: string;
  purchasedAt: string | null;
}

interface ItemRow {
  id: number;
  name: string;
  quantity: string | null;
  notes: string | null;
  category: string;
  category_confidence: number | null;
  purchased: number;
  created_at: string;
  purchased_at: string | null;
}

const toItem = (r: ItemRow): Item => ({
  id: r.id,
  name: r.name,
  quantity: r.quantity,
  notes: r.notes,
  category: r.category,
  categoryConfidence: r.category_confidence,
  purchased: r.purchased === 1,
  createdAt: r.created_at,
  purchasedAt: r.purchased_at,
});

export type NewItem = Pick<Item, "name" | "quantity" | "notes" | "category" | "categoryConfidence">;
export type ItemPatch = Partial<Pick<Item, "name" | "quantity" | "notes" | "category" | "purchased">>;

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT    NOT NULL,
      quantity            TEXT,
      notes               TEXT,
      category            TEXT    NOT NULL DEFAULT 'altro',
      category_confidence REAL,
      purchased           INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      purchased_at        TEXT
    );
  `);

  return {
    list(filter: { purchased?: boolean } = {}): Item[] {
      const rows =
        filter.purchased === undefined
          ? db.prepare("SELECT * FROM items ORDER BY purchased, category, id").all()
          : db
              .prepare("SELECT * FROM items WHERE purchased = ? ORDER BY category, id")
              .all(filter.purchased ? 1 : 0);
      return (rows as unknown as ItemRow[]).map(toItem);
    },

    get(id: number): Item | undefined {
      const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
      return row && toItem(row);
    },

    insert(item: NewItem): Item {
      const { lastInsertRowid } = db
        .prepare(
          "INSERT INTO items (name, quantity, notes, category, category_confidence) VALUES (?, ?, ?, ?, ?)",
        )
        .run(item.name, item.quantity, item.notes, item.category, item.categoryConfidence);
      return this.get(Number(lastInsertRowid))!;
    },

    update(id: number, patch: ItemPatch): Item | undefined {
      const current = this.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      const categoryChanged = patch.category !== undefined && patch.category !== current.category;
      const purchasedAt =
        next.purchased === current.purchased
          ? current.purchasedAt
          : next.purchased
            ? new Date().toISOString()
            : null;
      db.prepare(
        `UPDATE items SET name = ?, quantity = ?, notes = ?, category = ?, category_confidence = ?,
           purchased = ?, purchased_at = ? WHERE id = ?`,
      ).run(
        next.name,
        next.quantity,
        next.notes,
        next.category,
        categoryChanged ? null : current.categoryConfidence,
        next.purchased ? 1 : 0,
        purchasedAt,
        id,
      );
      return this.get(id);
    },

    remove(id: number): boolean {
      return db.prepare("DELETE FROM items WHERE id = ?").run(id).changes > 0;
    },

    close() {
      db.close();
    },
  };
}

export type Db = ReturnType<typeof openDb>;
