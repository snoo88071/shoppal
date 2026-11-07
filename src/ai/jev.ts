import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

/** Reparti del supermercato in cui Jev smista gli articoli. */
export const CATEGORIES = {
  frutta_verdura: "Frutta, verdura, erbe aromatiche fresche.",
  carne_pesce: "Carne, salumi, pesce, affettati.",
  latticini_uova: "Latte, formaggi, yogurt, burro, uova.",
  panetteria: "Pane, focacce, cornetti, prodotti da forno freschi.",
  dispensa: "Pasta, riso, legumi, conserve, condimenti, snack, colazione: cibo a lunga conservazione.",
  surgelati: "Prodotti congelati o surgelati.",
  bevande: "Acqua, bibite, succhi, vino, birra, caffè e tè.",
  pulizia_casa: "Detersivi, prodotti per la casa, carta, sacchetti.",
  cura_persona: "Igiene personale, cosmetici, farmaci da banco.",
  altro: "Nessuna delle altre categorie si adatta chiaramente.",
} as const;

export type Category = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[];

export interface Classification {
  category: Category;
  confidence: number;
  /** Probabilità (0–1) che l'articolo sia deperibile. */
  perishable: number;
}

/** Interfaccia minima: così nei test si può sostituire Jev con un finto classificatore. */
export interface ItemClassifier {
  classify(input: { name: string; notes?: string | null }): Promise<Classification>;
}

export function createJevClassifier(client = new TypeSafeClient()): ItemClassifier {
  return {
    async classify({ name, notes }) {
      const { answers } = await client.systemOne({
        state: { articolo: name, ...(notes ? { note: notes } : {}) },
        questions: {
          category: choice("In quale reparto del supermercato si trova questo articolo?", CATEGORIES),
          perishable: noul("L'articolo è deperibile (va consumato entro pochi giorni o tenuto in frigo)?"),
        },
      });
      return {
        category: answers.category.choice,
        confidence: answers.category.confidence,
        perishable: answers.perishable.noul,
      };
    },
  };
}
