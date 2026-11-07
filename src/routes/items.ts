import type { FastifyInstance } from "fastify";
import { CATEGORY_KEYS, type Category, type ItemClassifier } from "../ai/jev.ts";
import type { Db } from "../db.ts";

/** Sotto questa confidence la scelta di Jev viene scartata e l'articolo finisce in "altro". */
const MIN_CONFIDENCE = 0.5;

const idParams = {
  type: "object",
  properties: { id: { type: "integer", minimum: 1 } },
  required: ["id"],
} as const;

const nullableString = { type: ["string", "null"], maxLength: 500 } as const;

export function itemRoutes(app: FastifyInstance, opts: { db: Db; classifier: ItemClassifier | null }) {
  const { db, classifier } = opts;

  async function categorize(name: string, notes: string | null): Promise<{ category: Category; confidence: number | null }> {
    if (!classifier) return { category: "altro", confidence: null };
    try {
      const c = await classifier.classify({ name, notes });
      return c.confidence >= MIN_CONFIDENCE ? c : { category: "altro", confidence: c.confidence };
    } catch (err) {
      // L'AI non deve mai impedire di aggiungere un articolo alla lista.
      app.log.warn({ err }, "Classificazione Jev fallita, uso 'altro'");
      return { category: "altro", confidence: null };
    }
  }

  app.get<{ Querystring: { purchased?: boolean } }>(
    "/items",
    { schema: { querystring: { type: "object", properties: { purchased: { type: "boolean" } } } } },
    async (req) => db.list({ purchased: req.query.purchased }),
  );

  app.post<{ Body: { name: string; quantity?: string | null; notes?: string | null; category?: Category } }>(
    "/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            quantity: nullableString,
            notes: nullableString,
            category: { type: "string", enum: CATEGORY_KEYS },
          },
        },
      },
    },
    async (req, reply) => {
      const name = req.body.name.trim();
      const quantity = req.body.quantity ?? null;
      const notes = req.body.notes ?? null;
      const { category, confidence } = req.body.category
        ? { category: req.body.category, confidence: null }
        : await categorize(name, notes);
      const item = db.insert({ name, quantity, notes, category, categoryConfidence: confidence });
      return reply.code(201).send(item);
    },
  );

  app.patch<{
    Params: { id: number };
    Body: { name?: string; quantity?: string | null; notes?: string | null; category?: Category; purchased?: boolean };
  }>(
    "/items/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            quantity: nullableString,
            notes: nullableString,
            category: { type: "string", enum: CATEGORY_KEYS },
            purchased: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const item = db.update(req.params.id, req.body);
      return item ?? reply.code(404).send({ error: "Articolo non trovato" });
    },
  );

  app.delete<{ Params: { id: number } }>("/items/:id", { schema: { params: idParams } }, async (req, reply) =>
    db.remove(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "Articolo non trovato" }),
  );

  /** Endpoint di prova: chiede a Jev come classificherebbe un articolo, senza salvarlo. */
  app.post<{ Body: { name: string; notes?: string } }>(
    "/ai/classify",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 }, notes: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      if (!classifier) return reply.code(503).send({ error: "TYPESAFE_API_KEY non configurata" });
      return classifier.classify(req.body);
    },
  );
}
