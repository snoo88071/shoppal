# ShopPal

Bot Telegram personale per gestire le liste degli acquisti in linguaggio naturale, con **Jev** (TypeSafe AI, System One) per le decisioni e un LLM via **OpenRouter** per estrarre il testo.

**Stato:** passo 1 di 5 completato (modello dati e registro eventi). Il design è in [`docs/DESIGN.md`](docs/DESIGN.md).

## Sviluppo

Requisiti: [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
```

## Struttura

- `src/db/database.ts`: apertura del DB SQLite (`bun:sqlite`) e migrazioni (versione in `PRAGMA user_version`).
- `src/db/store.ts`: liste, voci, note, registro eventi, conferme in sospeso. Ogni modifica scrive il suo evento nella stessa transazione.
