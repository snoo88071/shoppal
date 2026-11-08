import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { createStore, StoreError } from "../src/db/store.ts";

/** Store su DB in memoria, con un orologio che i test possono spostare in avanti. */
function setup() {
  let clock = new Date("2026-11-01T10:00:00Z");
  const store = createStore(openDatabase(":memory:"), { now: () => clock });
  const advanceDays = (days: number) => (clock = new Date(clock.getTime() + days * 86_400_000));
  return { store, advanceDays };
}

const expectStoreError = (fn: () => unknown, code: StoreError["code"]) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe(code);
    return;
  }
  throw new Error(`Atteso StoreError ${code}`);
};

describe("liste", () => {
  test("si creano con nome e descrizione; il nome è unico tra le attive, senza distinguere maiuscole", () => {
    const { store } = setup();
    const sup = store.lists.create({ name: "  Supermercato ", description: "Cibo, bevande, detersivi" });
    expect(sup.name).toBe("Supermercato");
    expectStoreError(() => store.lists.create({ name: "supermercato", description: "x" }), "duplicate_name");
    expectStoreError(() => store.lists.create({ name: "Vivaio", description: "  " }), "invalid_state");

    store.lists.archive(sup.id);
    expect(store.lists.active()).toEqual([]);
    // Archiviata, il nome torna libero.
    expect(store.lists.create({ name: "Supermercato", description: "nuova" }).id).not.toBe(sup.id);
  });

  test("la modifica registra lo stato precedente", () => {
    const { store } = setup();
    const l = store.lists.create({ name: "Animali", description: "Cibo per il gatto" });
    store.lists.update(l.id, { description: "Cibo, lettiera e giochi per il gatto" });
    const [ev] = store.events.list({ types: ["list_updated"] });
    expect(ev!.payload).toEqual({
      before: { name: "Animali", description: "Cibo per il gatto" },
      after: { name: "Animali", description: "Cibo, lettiera e giochi per il gatto" },
    });
  });
});

describe("voci", () => {
  test("ciclo di vita completo, con un evento per ogni passo", () => {
    const { store } = setup();
    const sup = store.lists.create({ name: "Supermercato", description: "Spesa alimentare" });
    const pesto = store.entries.add({ listId: sup.id, name: "pesto" }, { sourceMessageId: 42 });

    store.entries.rename(pesto.id, "pesto barilla senza aglio");
    store.entries.markDone(pesto.id);
    expect(store.entries.open(sup.id)).toEqual([]);
    expectStoreError(() => store.entries.markDone(pesto.id), "invalid_state");
    store.entries.reopen(pesto.id);
    expect(store.entries.open(sup.id).map((e) => e.name)).toEqual(["pesto barilla senza aglio"]);

    const history = store.events.list({ entryId: pesto.id }).reverse();
    expect(history.map((e) => e.type)).toEqual(["entry_added", "entry_renamed", "entry_done", "entry_reopened"]);
    expect(history[0]!.sourceMessageId).toBe(42);
    expect(history[1]!.payload).toEqual({ from: "pesto", to: "pesto barilla senza aglio" });
  });

  test("la rimozione salva il motivo", () => {
    const { store } = setup();
    const wish = store.lists.create({ name: "Wishlist", description: "Desideri, niente di urgente" });
    const chitarra = store.entries.add({ listId: wish.id, name: "chitarra elettrica" });
    store.entries.remove(chitarra.id, { reason: "ho troppi strumenti a casa" });
    const [ev] = store.events.list({ types: ["entry_removed"] });
    expect(ev!.reason).toBe("ho troppi strumenti a casa");
    expect(ev!.payload).toEqual({ from: "open", to: "removed" });
  });

  test("spostamento dalla wishlist a un negozio", () => {
    const { store } = setup();
    const wish = store.lists.create({ name: "Wishlist", description: "Desideri" });
    const musica = store.lists.create({ name: "Strumenti musicali", description: "Strumenti e accessori" });
    const pelli = store.entries.add({ listId: wish.id, name: "pelli del rullante" });
    store.entries.move(pelli.id, musica.id);
    expect(store.entries.open(musica.id).map((e) => e.name)).toEqual(["pelli del rullante"]);
    expectStoreError(() => store.entries.move(pelli.id, musica.id), "invalid_state");
  });

  test("non si aggiunge a una lista inesistente o archiviata", () => {
    const { store } = setup();
    expectStoreError(() => store.entries.add({ listId: 99, name: "x" }), "not_found");
    const l = store.lists.create({ name: "Elettronica", description: "Cavi, gadget" });
    store.lists.archive(l.id);
    expectStoreError(() => store.entries.add({ listId: l.id, name: "cavo usb" }), "invalid_state");
  });

  test("recent(): aperte più chiuse negli ultimi N giorni, escluse le liste archiviate", () => {
    const { store, advanceDays } = setup();
    const sup = store.lists.create({ name: "Supermercato", description: "Spesa" });
    const old = store.lists.create({ name: "Vecchia", description: "Archiviata" });
    const pane = store.entries.add({ listId: sup.id, name: "pane" });
    store.entries.markDone(pane.id); // chiuso al giorno 0
    advanceDays(5);
    const latte = store.entries.add({ listId: sup.id, name: "latte" });
    const uova = store.entries.add({ listId: sup.id, name: "uova" });
    store.entries.remove(uova.id); // chiuso al giorno 5
    store.entries.add({ listId: old.id, name: "nascosto" });
    store.lists.archive(old.id);

    expect(store.entries.recent().map((e) => e.name)).toEqual(["latte", "uova", "pane"]);
    advanceDays(3); // il pane è stato chiuso 8 giorni fa
    expect(store.entries.recent().map((e) => e.name)).toEqual(["latte", "uova"]);
    expect(store.entries.recent({ limit: 1 }).map((e) => e.id)).toEqual([latte.id]);
  });
});

describe("note", () => {
  test("una nota 'da non comprare' compare finché non scade, sia generale sia per lista", () => {
    const { store, advanceDays } = setup();
    const sup = store.lists.create({ name: "Supermercato", description: "Spesa" });
    const vivaio = store.lists.create({ name: "Vivaio", description: "Piante, terriccio, vasi" });
    store.notes.add(
      {
        listId: sup.id,
        subject: "pollo",
        text: "non comprarlo, c'è ancora quello di ieri",
        kind: "avoid",
        expiresAt: "2026-11-03T10:00:00Z",
      },
      { reason: "ho ancora quello di ieri da consumare" },
    );
    store.notes.add({ subject: "contanti", text: "porta i contanti", kind: "info" });

    expect(store.notes.active({ listId: sup.id }).map((n) => n.subject)).toEqual(["pollo", "contanti"]);
    expect(store.notes.active({ listId: vivaio.id }).map((n) => n.subject)).toEqual(["contanti"]);
    expect(store.notes.active({ kind: "avoid" }).map((n) => n.subject)).toEqual(["pollo"]);
    advanceDays(3);
    expect(store.notes.active({ kind: "avoid" })).toEqual([]);
  });

  test("rimozione con evento", () => {
    const { store } = setup();
    const n = store.notes.add({ subject: "pollo", text: "non comprarlo", kind: "avoid" });
    store.notes.remove(n.id);
    expect(store.notes.active()).toEqual([]);
    expectStoreError(() => store.notes.remove(n.id), "invalid_state");
    expect(store.events.list({ types: ["note_added", "note_removed"] }).map((e) => e.type)).toEqual([
      "note_removed",
      "note_added",
    ]);
  });
});

describe("conferme in sospeso", () => {
  test("si risolvono una volta sola", () => {
    const { store } = setup();
    const p = store.pending.create({ question: "Supermercato o Animali?", options: [1, 2] });
    store.pending.setTelegramMessage(p.id, 777);
    expect(store.pending.unresolved()).toEqual([{ ...p, telegramMessageId: 777 }]);
    expect(store.pending.resolve(p.id)).toBe(true);
    expect(store.pending.resolve(p.id)).toBe(false); // pulsante premuto due volte
    expect(store.pending.unresolved()).toEqual([]);
  });
});

describe("database", () => {
  test("se la scrittura dell'evento fallisce, anche la modifica viene annullata", () => {
    const db = openDatabase(":memory:");
    const store = createStore(db);
    // Un trigger che fa fallire ogni inserimento nel registro eventi, dopo che la lista è già stata scritta.
    db.run("CREATE TRIGGER boom BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => store.lists.create({ name: "Supermercato", description: "Spesa" })).toThrow("boom");
    expect(store.lists.active()).toEqual([]);
  });

  test("su file i dati sopravvivono alla riapertura e le migrazioni non si ripetono", () => {
    const dir = mkdtempSync(join(tmpdir(), "shoppal-"));
    try {
      const path = join(dir, "nested", "test.db");
      const db1 = openDatabase(path);
      createStore(db1).lists.create({ name: "Vivaio", description: "Piante" });
      db1.close();

      const db2 = openDatabase(path);
      expect(createStore(db2).lists.active().map((l) => l.name)).toEqual(["Vivaio"]);
      expect((db2.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
