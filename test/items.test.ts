import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemClassifier } from "../src/ai/jev.ts";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

const fakeJev = (confidence = 0.9): ItemClassifier => ({
  async classify({ name }) {
    return { category: name.includes("latte") ? "latticini_uova" : "dispensa", confidence, perishable: 0.5 };
  },
});

const setup = (classifier: ItemClassifier | null = fakeJev()) => buildApp({ db: openDb(":memory:"), classifier });

test("crea un articolo categorizzato da Jev, lo segna come comprato e lo elimina", async (t) => {
  const app = setup();
  t.after(() => app.close());

  const created = await app.inject({ method: "POST", url: "/items", payload: { name: " latte intero ", quantity: "2 L" } });
  assert.equal(created.statusCode, 201);
  const item = created.json();
  assert.equal(item.name, "latte intero");
  assert.equal(item.category, "latticini_uova");
  assert.equal(item.categoryConfidence, 0.9);
  assert.equal(item.purchased, false);

  const bought = await app.inject({ method: "PATCH", url: `/items/${item.id}`, payload: { purchased: true } });
  assert.equal(bought.json().purchased, true);
  assert.ok(bought.json().purchasedAt);

  const toBuy = await app.inject({ method: "GET", url: "/items?purchased=false" });
  assert.deepEqual(toBuy.json(), []);

  assert.equal((await app.inject({ method: "DELETE", url: `/items/${item.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: "DELETE", url: `/items/${item.id}` })).statusCode, 404);
});

test("con confidence bassa, senza AI o se Jev fallisce l'articolo finisce in 'altro'", async (t) => {
  const failing: ItemClassifier = { classify: async () => Promise.reject(new Error("boom")) };
  for (const classifier of [fakeJev(0.2), null, failing]) {
    const app = setup(classifier);
    t.after(() => app.close());
    const res = await app.inject({ method: "POST", url: "/items", payload: { name: "pasta" } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().category, "altro");
  }
});

test("la categoria indicata a mano ha la precedenza e azzera la confidence", async (t) => {
  const app = setup();
  t.after(() => app.close());
  const res = await app.inject({ method: "POST", url: "/items", payload: { name: "latte", category: "bevande" } });
  assert.equal(res.json().category, "bevande");
  assert.equal(res.json().categoryConfidence, null);

  const patched = await app.inject({ method: "PATCH", url: `/items/${res.json().id}`, payload: { category: "altro" } });
  assert.equal(patched.json().category, "altro");
});

test("valida l'input", async (t) => {
  const app = setup();
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/items", payload: { name: "" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/items", payload: { name: "x", category: "boh" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: "/items/1", payload: {} })).statusCode, 400);
});
