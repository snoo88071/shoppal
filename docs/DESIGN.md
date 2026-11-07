# ShopPal — Design

> Stato: **bozza da rivedere**. Il codice attuale (categorizzazione per reparti) verrà sostituito seguendo questo documento.

## Obiettivo

Un bot Telegram personale per gestire liste di acquisti scrivendo in linguaggio naturale, anche più azioni in un solo messaggio:

> "aggiungi pane, latte e uova alla spesa… poi scatolette Royal Canin e croccantini per il negozio di animali… poi rimuovi chitarra elettrica dalla wishlist, ho troppi strumenti a casa"

Il bot esegue le azioni di cui è sicuro, chiede conferma con dei pulsanti per quelle incerte e risponde con un riepilogo. "Stampa la lista X" significa che il bot risponde in chat con quella lista.

## Principio: l'LLM scrive, Jev decide

- **Jev** (TypeSafe AI, System One) risponde solo a domande chiuse (scelta, sì/no, punteggio) con probabilità e confidence. Prende **tutte le decisioni**: quale azione, quale lista, se una voce esiste già.
- **L'LLM** (OpenRouter) serve **solo a produrre testo**: spezzare un messaggio in più azioni, estrarre il nome dell'oggetto, il motivo e la data, proporre nome e descrizione di una nuova lista. **Non decide nulla.**

## Stack

- **TypeScript su Bun**: Bun esegue TypeScript direttamente, quindi niente build. I test usano `bun test` e il `.env` viene caricato in automatico.
- **SQLite** con `bun:sqlite`, integrato in Bun. Il DB è un unico file.
- **grammY** per il bot Telegram, in modalità polling.
- **`@typesafe-ai/sdk`** per Jev; **OpenRouter** per l'LLM.
- **Nessun server HTTP** per ora. Se servirà un'interfaccia web, lo aggiungeremo (con Fastify o con il server integrato di Bun).

## Architettura

```
Telegram ◀──(polling, grammY)── bot ──▶ pipeline ──▶ Jev (decisioni)
                                 │          └──────▶ OpenRouter (estrazione testo)
                                 ▼
                          SQLite (file locale)
```

- **Un solo processo Bun**, che gira sul **PC di casa**.
- **Perché funziona anche fuori casa:** il bot non riceve connessioni. È lui a chiedere a Telegram se ci sono messaggi nuovi (polling), quindi non servono porte aperte sul router né un IP pubblico. Basta che il PC sia acceso.
- **Se il PC è spento o in sospensione**, Telegram tiene i messaggi da parte per circa 24 ore e il bot li elabora alla riaccensione.
- **Accesso:** il bot risponde **solo** a `TELEGRAM_CHAT_ID` e ignora tutti gli altri.
- **Due bot, uno per lo sviluppo e uno per l'uso quotidiano**, con token diversi. Telegram accetta un solo processo in polling per bot: se ne avvii due con lo stesso token, si rubano i messaggi.
- **Avvio automatico** all'accensione di Windows (Utilità di pianificazione o simili).
- **Railway** o simili restano un'opzione futura, se servisse un bot sempre acceso. In quel caso SQLite andrebbe su un volume persistente.

### Configurazione (`.env`)

| Variabile | Note |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | da @BotFather |
| `TELEGRAM_CHAT_ID` | unica chat autorizzata |
| `TYPESAFE_API_KEY` | Jev |
| `OPENROUTER_API_KEY` | LLM |
| `OPENROUTER_MODELS` | lista in ordine di priorità, separata da virgole. Default: `nvidia/nemotron-3.5-super-vl:free,google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| `DB_PATH` | default `data/shoppal.db` |

Se un modello OpenRouter fallisce (limite di richieste, errore, JSON non valido), si passa al successivo. Se falliscono tutti, il bot risponde "non riesco a interpretare il messaggio adesso, riprova più tardi" e non applica nulla.

## Modello dati

Una lista corrisponde a un **tipo di negozio**: supermercato, negozio di articoli per animali, negozio di strumenti musicali, vivaio/garden shop, negozio di elettronica… La wishlist è una lista come le altre. **Non ci sono altre categorie:** gli articoli non vengono smistati in reparti o simili.

All'inizio **non esiste nessuna lista**: le crea l'utente, ognuna con un nome e una **descrizione** di cosa ci va (es. *Vivaio*: "piante, semi, terriccio, vasi, attrezzi da giardino").

Le descrizioni sono anche le opzioni che Jev riceve quando deve scegliere la lista: una buona descrizione migliora direttamente le sue scelte.

| Tabella | Campi principali | Note |
| --- | --- | --- |
| `lists` | id, name, description, created_at, archived_at | |
| `entries` | id, list_id, name, status (`open` / `done` / `removed`), created_at, updated_at | una voce di una lista |
| `notes` | id, list_id?, entry_id?, subject, text, kind (`info` / `avoid`), expires_at? | es. "non comprare pollo, c'è ancora quello di ieri" → `kind=avoid`, `subject=pollo` |
| `events` | id, type, list_id?, entry_id?, reason?, payload (JSON), source_message_id, created_at | registro di tutto ciò che succede |
| `pending_confirmations` | id, telegram_message_id, payload (JSON), created_at, resolved_at? | le domande con pulsanti in attesa; restano nel DB e sopravvivono ai riavvii |

**Eventi.** Ogni azione registra un evento, con il **motivo** quando c'è ("rimossa: ho troppi strumenti"). I tipi sono generici: `entry_added`, `entry_renamed`, `entry_done`, `entry_removed`, `note_added`, `list_created`, … Le liste future (cibi buttati, acquisti mai usati, resi, rivenduti, cose da consumare entro una data) diventeranno **viste sul registro eventi** o nuovi tipi di evento, senza dover riprogettare il DB.

**Note `avoid`.** Compaiono come avviso quando si stampa la lista collegata. Se si prova ad aggiungere un oggetto che corrisponde a una nota `avoid` (il confronto lo fa Jev), il bot avvisa e chiede conferma.

## Pipeline di un messaggio

### 1. Triage (Jev, 1 chiamata)

Jev riceve: il messaggio, le liste (nome e descrizione) e le voci recenti (aperte, più quelle chiuse da poco). Le domande:

- `kind`, una scelta tra:
  - `show_list`: mostra una lista;
  - `simple_on_existing`: una sola azione su una voce che esiste già, es. "ho comprato il pesto";
  - `needs_extraction`: tutto il resto, cioè oggetti nuovi o più azioni.
- `list`: una scelta tra le liste, più `none`.
- `entry`: una scelta tra le voci recenti, più `none`.

Se il caso è semplice e Jev è sicuro, si esegue subito, **senza chiamare l'LLM**.

### 2. Estrazione (LLM)

L'LLM restituisce un JSON validato con uno schema:

```json
[{ "text": "rimuovi chitarra elettrica dalla wishlist, ho troppi strumenti",
   "object": "chitarra elettrica", "list_hint": "wishlist",
   "reason": "ho troppi strumenti a casa", "date": null }]
```

`list_hint` è solo il testo scritto dall'utente: la lista vera la sceglie Jev al passo 3.

### 3. Decisione per ogni azione (Jev)

Per ogni elemento estratto:

- `action`, una scelta tra: `add`, `remove`, `mark_done`, `add_note`, `avoid`, `create_list`, `show_list`.
- `list`: una scelta tra le liste, con le **descrizioni** come criteri, più `none_fits`.
- `duplicate`: una scelta tra le voci aperte di quella lista, più `new`.

Se è stato trovato un possibile doppione, c'è una seconda domanda: `relation`, una scelta tra `same` (non aggiungo nulla), `more_specific` (rinomino, es. "pesto" → "pesto barilla senza aglio") e `different` (aggiungo).

Se vince `none_fits`, l'LLM propone nome e descrizione di una nuova lista e il bot mostra i pulsanti:
`[Crea "Negozio strumenti musicali"]` `[Scegli una lista esistente]` `[Scrivo io]`.

### 4. Quando si chiede conferma

Si chiede conferma se la prima opzione ha probabilità sotto `MIN_TOP` **oppure** se le prime due sono troppo vicine (differenza < `MIN_MARGIN`). Esempio: supermercato 51%, animali 52% → «Supermercato o negozio di animali?».

Valori iniziali: `MIN_TOP = 0.6`, `MIN_MARGIN = 0.15`. Sono configurabili e li tareremo con l'uso.

### 5. Esecuzione e risposta

Le azioni sicure si applicano subito. Per quelle incerte si salva una conferma in sospeso e si mostrano i pulsanti. Il bot risponde con un unico riepilogo:

> ✅ Aggiunti a *Supermercato*: pane, latte, uova
> ✅ Rimossa da *Wishlist*: chitarra elettrica (motivo: troppi strumenti)
> ❓ «Croccantini Royal Canin»: *Animali* o *Supermercato*? `[Animali]` `[Supermercato]`

## Testabilità

Jev e l'LLM stanno dietro due interfacce (`Decider`, `Extractor`). Nei test (`bun test`) si usano versioni finte e deterministiche: la pipeline si testa senza rete e senza chiavi. Per il DB si usa SQLite in memoria. Uno script separato fa una prova vera con le chiavi reali.

## Piano di lavoro

1. Passaggio a Bun, togliendo Node, `tsx` e Fastify. Modello dati, migrazioni, repository e registro eventi, con test.
2. Interfacce `Decider` (Jev) ed `Extractor` (OpenRouter con modelli di riserva).
3. Pipeline (triage → estrazione → decisione → esecuzione) con test sugli esempi reali.
4. Bot Telegram: grammY, filtro sul chat id, pulsanti di conferma, stampa liste.
5. Esecuzione sul PC di casa: avvio automatico su Windows e istruzioni nel README.

## Punti aperti

- **Annullare l'ultima azione** ("annulla", oppure un pulsante sotto ogni riepilogo). Grazie al registro eventi è facile ed è utile perché l'AI sbaglierà. Proposta: sì, al passo 4.
- **Quante voci recenti passare a Jev:** proposta le voci aperte più quelle chiuse negli ultimi 7 giorni, entro il limite di 255 opzioni.
- **Scadenza delle note `avoid`:** si usa la data estratta, se c'è; altrimenti restano finché non vengono rimosse.
