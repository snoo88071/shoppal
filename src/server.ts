import { existsSync } from "node:fs";
import { createJevClassifier } from "./ai/jev.ts";
import { buildApp } from "./app.ts";
import { openDb } from "./db.ts";

// Carica .env se presente. Le variabili già definite nel sistema (es. env vars di Windows) NON vengono sovrascritte.
if (existsSync(".env")) process.loadEnvFile(".env");

const db = openDb(process.env.DB_PATH ?? "data/shoppal.db");
const classifier = process.env.TYPESAFE_API_KEY ? createJevClassifier() : null;

const app = buildApp({ db, classifier }, { logger: true });
if (!classifier) app.log.warn("TYPESAFE_API_KEY non impostata: categorizzazione AI disattivata");

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "127.0.0.1" });
