# ShopPal

Gestore personale delle compere, AI-powered con **Jev** (modello *System One* di [TypeSafe AI](https://typesafe.ai)).

Jev non genera testo: risponde a domande tipizzate (scelta, sì/no, punteggio) con probabilità e confidence.
Qui lo usiamo per smistare automaticamente ogni articolo nel reparto giusto del supermercato.

## Stack

- **Fastify 5** + TypeScript (eseguito con `tsx`, niente build step)
- **SQLite** file-based tramite il modulo integrato `node:sqlite` (nessuna dipendenza nativa da compilare, anche su Windows). Il DB sta in `data/shoppal.db`.
- **`@typesafe-ai/sdk`** per le chiamate a Jev

## Setup sulla tua macchina

Requisiti: **Node.js 22.13 o più recente**.

```bash
git clone https://github.com/snoo88071/shoppal.git
cd shoppal
npm install
copy .env.example .env   # su macOS/Linux: cp .env.example .env
```

Poi metti la chiave in `.env` (`TYPESAFE_API_KEY=...`).
Se `TYPESAFE_API_KEY` è già tra le variabili d'ambiente di Windows, non serve: le variabili di sistema hanno la precedenza su `.env`.

```bash
npm run dev        # server con auto-reload su http://127.0.0.1:3000
npm test           # test (Jev è sostituito da un finto classificatore)
npm run typecheck
```

> Node stampa `ExperimentalWarning: SQLite is an experimental feature`: è normale, `node:sqlite` funziona senza flag da Node 22.13.

## API

| Metodo | Percorso | Descrizione |
| --- | --- | --- |
| `GET` | `/health` | Stato del server e se l'AI è attiva |
| `GET` | `/items?purchased=false` | Lista articoli (filtro opzionale) |
| `POST` | `/items` | `{ name, quantity?, notes?, category? }` — senza `category`, la sceglie Jev |
| `PATCH` | `/items/:id` | Modifica campi, es. `{ "purchased": true }` |
| `DELETE` | `/items/:id` | Elimina |
| `POST` | `/ai/classify` | `{ name, notes? }` — prova la classificazione di Jev senza salvare |

Se Jev non è configurato, risponde con confidence < 0.5 o la chiamata fallisce, l'articolo viene comunque salvato in `altro`.
Le categorie sono definite in `src/ai/jev.ts`.
