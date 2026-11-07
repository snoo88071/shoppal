import Fastify, { type FastifyServerOptions } from "fastify";
import type { ItemClassifier } from "./ai/jev.ts";
import type { Db } from "./db.ts";
import { itemRoutes } from "./routes/items.ts";

export function buildApp(deps: { db: Db; classifier: ItemClassifier | null }, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);

  app.get("/health", async () => ({ ok: true, ai: deps.classifier ? "jev" : "disabled" }));
  app.register(async (scope) => itemRoutes(scope, deps));
  app.addHook("onClose", async () => deps.db.close());

  return app;
}
