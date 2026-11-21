import { describe, expect, it } from "vitest";
import {
  choisirJobASuivre,
  delaiProchainEssai,
  DELAI_MAX_BANDEAU_MS,
  dureeEcoulee,
  dureeJob,
  dureeLisible,
  estActif,
  INTERVALLE_BANDEAU_MS,
  libellePhase,
  operationsEnCours,
  STATUTS_ACTIFS,
  type JobOperation,
  type JobSuivi,
} from "./jobs";

function job(partiel: Partial<JobSuivi> & { id: string }): JobSuivi {
  return { status: "pending", ...partiel };
}

describe("STATUTS_ACTIFS / estActif", () => {
  it("ne considère actifs que pending et running", () => {
    expect([...STATUTS_ACTIFS].sort()).toEqual(["pending", "running"]);
    expect(estActif(job({ id: "a", status: "pending" }))).toBe(true);
    expect(estActif(job({ id: "b", status: "running" }))).toBe(true);
    expect(estActif(job({ id: "c", status: "done" }))).toBe(false);
    expect(estActif(job({ id: "d", status: "error" }))).toBe(false);
    expect(estActif(null)).toBe(false);
    expect(estActif(undefined)).toBe(false);
  });
});

describe("delaiProchainEssai", () => {
  it("garde la cadence normale au premier échec, puis double", () => {
    expect(delaiProchainEssai(0)).toBe(INTERVALLE_BANDEAU_MS);
    expect(delaiProchainEssai(1)).toBe(INTERVALLE_BANDEAU_MS);
    expect(delaiProchainEssai(2)).toBe(INTERVALLE_BANDEAU_MS * 2);
    expect(delaiProchainEssai(3)).toBe(INTERVALLE_BANDEAU_MS * 4);
  });

  it("plafonne l'attente pour ne pas geler le bandeau", () => {
    expect(delaiProchainEssai(4)).toBe(DELAI_MAX_BANDEAU_MS);
    expect(delaiProchainEssai(1_000)).toBe(DELAI_MAX_BANDEAU_MS);
  });

  it("accepte une cadence et un plafond explicites", () => {
    expect(delaiProchainEssai(2, 1_000, 5_000)).toBe(2_000);
    expect(delaiProchainEssai(3, 1_000, 5_000)).toBe(4_000);
    expect(delaiProchainEssai(4, 1_000, 5_000)).toBe(5_000);
  });

  it("ignore un compteur invalide", () => {
    expect(delaiProchainEssai(-1)).toBe(INTERVALLE_BANDEAU_MS);
    expect(delaiProchainEssai(Number.NaN)).toBe(INTERVALLE_BANDEAU_MS);
  });
});

describe("choisirJobASuivre", () => {
  it("renvoie null sans job ou sans job actif", () => {
    expect(choisirJobASuivre([])).toBeNull();
    expect(choisirJobASuivre(null)).toBeNull();
    expect(choisirJobASuivre([job({ id: "a", status: "done" })])).toBeNull();
  });

  it("choisit le job actif le plus récent, pas le premier de la liste", () => {
    const ancien = job({
      id: "ancien",
      status: "running",
      created_at: "2026-01-01T10:00:00Z",
    });
    const recent = job({
      id: "recent",
      status: "pending",
      created_at: "2026-01-01T12:00:00Z",
    });
    const termine = job({
      id: "termine",
      status: "done",
      created_at: "2026-01-01T13:00:00Z",
    });
    expect(choisirJobASuivre([ancien, recent, termine])?.id).toBe("recent");
  });

  it("ignore un job actif sans date exploitable face à un job daté", () => {
    const sansDate = job({ id: "sans-date", status: "running" });
    const date = job({
      id: "date",
      status: "running",
      created_at: "2026-01-01T10:00:00Z",
    });
    expect(choisirJobASuivre([sansDate, date])?.id).toBe("date");
  });
});

describe("dureeEcoulee", () => {
  it("calcule un écart positif", () => {
    expect(dureeEcoulee("2026-01-01T10:00:00Z", Date.parse("2026-01-01T10:00:05Z"))).toBe(5000);
  });

  it("borne à zéro un début dans le futur", () => {
    expect(dureeEcoulee("2026-01-01T10:00:10Z", Date.parse("2026-01-01T10:00:00Z"))).toBe(0);
  });

  it("renvoie null sans date ou avec une date illisible", () => {
    expect(dureeEcoulee(null)).toBeNull();
    expect(dureeEcoulee(undefined)).toBeNull();
    expect(dureeEcoulee("pas une date")).toBeNull();
  });
});

describe("dureeLisible", () => {
  it("formate les millisecondes, secondes, minutes et heures", () => {
    expect(dureeLisible(850)).toBe("850 ms");
    expect(dureeLisible(4200)).toBe("4,2 s");
    expect(dureeLisible(127_000)).toBe("2 min 07 s");
    expect(dureeLisible(3_780_000)).toBe("1 h 03 min");
  });

  it("renvoie null pour une valeur absente ou invalide", () => {
    expect(dureeLisible(null)).toBeNull();
    expect(dureeLisible(undefined)).toBeNull();
    expect(dureeLisible(-1)).toBeNull();
    expect(dureeLisible(Number.NaN)).toBeNull();
  });
});

describe("dureeJob", () => {
  it("privilégie la durée mesurée par le serveur", () => {
    expect(
      dureeJob(
        job({
          id: "a",
          status: "done",
          duration_ms: 1234,
          started_at: "2026-01-01T10:00:00Z",
          finished_at: "2026-01-01T10:00:09Z",
        })
      )
    ).toBe(1234);
  });

  it("retombe sur finished_at - started_at sans durée serveur", () => {
    expect(
      dureeJob(
        job({
          id: "a",
          status: "done",
          started_at: "2026-01-01T10:00:00Z",
          finished_at: "2026-01-01T10:00:09Z",
        })
      )
    ).toBe(9000);
  });

  it("compte le temps écoulé pour un job actif", () => {
    expect(
      dureeJob(
        job({ id: "a", status: "running", started_at: "2026-01-01T10:00:00Z" }),
        Date.parse("2026-01-01T10:00:02Z")
      )
    ).toBe(2000);
  });

  it("compte depuis la demande pour un job en attente sans prise en charge", () => {
    expect(
      dureeJob(
        job({ id: "a", status: "pending", created_at: "2026-01-01T10:00:00Z" }),
        Date.parse("2026-01-01T10:00:03Z")
      )
    ).toBe(3000);
  });

  it("renvoie null pour un job terminé sans aucune date de début", () => {
    expect(dureeJob(job({ id: "a", status: "done" }))).toBeNull();
  });
});

describe("libellePhase", () => {
  it("traduit les phases connues", () => {
    expect(libellePhase("manifeste")).toBe("Préparation du manifeste");
    expect(libellePhase("lecture")).toBe("Lecture et compression");
    expect(libellePhase("upload")).toBe("Envoi des parties");
    expect(libellePhase("index")).toBe("Écriture de l’index");
    expect(libellePhase("finalisation")).toBe("Finalisation");
  });

  it("affiche une phase inconnue telle quelle plutôt que de la masquer", () => {
    expect(libellePhase("nouvelle_phase")).toBe("nouvelle_phase");
  });

  it("renvoie null pour une phase absente", () => {
    expect(libellePhase("")).toBeNull();
    expect(libellePhase(null)).toBeNull();
    expect(libellePhase(undefined)).toBeNull();
  });
});

describe("operationsEnCours", () => {
  function operation(partiel: Partial<JobOperation> & { id: string }): JobOperation {
    return { status: "running", ...partiel };
  }

  const maintenant = Date.parse("2026-01-01T12:00:10Z");

  it("ne garde que les jobs actifs et ignore les rapports terminés", () => {
    const operations = operationsEnCours(
      [
        operation({
          id: "export",
          kind: "export",
          status: "running",
          started_at: "2026-01-01T12:00:00Z",
          destination: "_sauvegardes/2026",
        }),
        operation({
          id: "fini",
          kind: "export",
          status: "done",
          started_at: "2026-01-01T11:00:00Z",
        }),
      ],
      [],
      maintenant
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      id: "export",
      type: "export",
      onglet: "sauvegardes",
      detail: "_sauvegardes/2026",
      duree: 10_000,
    });
  });

  it("distingue export, restauration et import, avec leur onglet", () => {
    const operations = operationsEnCours(
      [
        operation({ id: "e", kind: "export", destination: "_sauvegardes/e" }),
        operation({
          id: "r",
          kind: "restore",
          source: "_sauvegardes/source",
          phase: "verification",
        }),
      ],
      [operation({ id: "i", filename: "catalogue.zip" })],
      maintenant
    );

    expect(operations.map((o) => o.type).sort()).toEqual(["export", "import", "restore"]);
    expect(operations.find((o) => o.id === "r")).toMatchObject({
      onglet: "sauvegardes",
      detail: "_sauvegardes/source",
      phase: "Vérification",
    });
    expect(operations.find((o) => o.id === "i")).toMatchObject({
      onglet: "import",
      detail: "catalogue.zip",
    });
  });

  it("trie la plus longue opération d'abord", () => {
    const operations = operationsEnCours(
      [
        operation({
          id: "courte",
          started_at: "2026-01-01T12:00:05Z",
          destination: "_sauvegardes/courte",
        }),
        operation({
          id: "longue",
          started_at: "2026-01-01T11:00:00Z",
          destination: "_sauvegardes/longue",
        }),
      ],
      [],
      maintenant
    );

    expect(operations.map((o) => o.id)).toEqual(["longue", "courte"]);
  });

  it("accepte des listes absentes et un job en attente sans date", () => {
    expect(operationsEnCours(null, undefined, maintenant)).toEqual([]);

    const [operationEnAttente] = operationsEnCours(
      [operation({ id: "attente", status: "pending" })],
      [],
      maintenant
    );
    expect(operationEnAttente.duree).toBeNull();
    expect(operationEnAttente.phase).toBeNull();
  });
});
