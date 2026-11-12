import { describe, expect, it } from "vitest";
import {
  actionClavier,
  ancrePourPage,
  bornerPage,
  directionBalayage,
  ECART_PAGES,
  dimensionsFeuille,
  ecrireAffichage,
  finDernierePage,
  largeurColonne,
  LARGEUR_MIN_FEUILLE,
  RATIO_A4,
  zoneTexte,
  lireAffichage,
  nombrePages,
  normaliserAffichage,
  pagePourAncre,
} from "./pagination";

describe("préférence d'affichage", () => {
  it("retombe sur le défilement continu pour toute valeur inconnue", () => {
    expect(normaliserAffichage("pages")).toBe("pages");
    for (const v of [null, undefined, "", "Pages", "defilement", 1]) expect(normaliserAffichage(v)).toBe("defilement");
  });
  it("relit ce qui a été écrit ; stockage cassé ou absent sans erreur", () => {
    const d: Record<string, string> = {};
    const s = { getItem: (k: string) => d[k] ?? null, setItem: (k: string, v: string) => void (d[k] = v) };
    expect(lireAffichage(s)).toBe("defilement");
    ecrireAffichage("pages", s);
    expect(lireAffichage(s)).toBe("pages");
    const casse = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(lireAffichage(casse)).toBe("defilement");
    expect(() => ecrireAffichage("pages", casse)).not.toThrow();
    expect(lireAffichage(null)).toBe("defilement");
  });
});

describe("nombrePages", () => {
  const L = 600;
  it("n colonnes = n·L + (n−1)·écart", () => {
    expect(nombrePages(L, L)).toBe(1);
    expect(nombrePages(2 * L + ECART_PAGES, L)).toBe(2);
    expect(nombrePages(7 * L + 6 * ECART_PAGES, L)).toBe(7);
  });
  it("tolère les demi-pixels et les valeurs aberrantes", () => {
    expect(nombrePages(2 * L + ECART_PAGES + 0.6, L)).toBe(2);
    expect(nombrePages(100, L)).toBe(1);
    expect(nombrePages(NaN, L)).toBe(1);
    expect(nombrePages(1000, 0)).toBe(1);
  });
});

describe("bornerPage", () => {
  it("reste dans [0, total−1]", () => {
    expect(bornerPage(-3, 5)).toBe(0);
    expect(bornerPage(2, 5)).toBe(2);
    expect(bornerPage(9, 5)).toBe(4);
    expect(bornerPage(1.4, 5)).toBe(1);
    expect(bornerPage(NaN, 5)).toBe(0);
    expect(bornerPage(3, 0)).toBe(0);
  });
});

describe("ancre d'une page (survivre à un changement de mise en page)", () => {
  // avant : p0 = blocs 0, 40 · p1 = bloc 90 et em 120 dans le long paragraphe 100 qui déborde sur p2 · p3 = bloc 300
  const avant = [
    { start: 0, page: 0 }, { start: 40, page: 0 }, { start: 90, page: 1 }, { start: 100, page: 1 }, { start: 120, page: 1 }, { start: 300, page: 3 },
  ];
  it("= premier bloc commencé sur la page", () => {
    expect(ancrePourPage(avant, 0)).toBe(0);
    expect(ancrePourPage(avant, 1)).toBe(90);
    expect(ancrePourPage(avant, 3)).toBe(300);
  });
  it("page sans début de bloc (suite d'un paragraphe) = dernier bloc commencé avant", () => {
    expect(ancrePourPage(avant, 2)).toBe(120);
  });
  it("aucun élément : null", () => {
    expect(ancrePourPage([], 0)).toBeNull();
  });
  it("retrouve la bonne page après reflux (police plus grande : plus de pages)", () => {
    const apres = [
      { start: 0, page: 0 }, { start: 40, page: 1 }, { start: 90, page: 2 }, { start: 100, page: 2 }, { start: 120, page: 3 }, { start: 300, page: 6 },
    ];
    expect(pagePourAncre(apres, 90)).toBe(2);
    expect(pagePourAncre(apres, 300)).toBe(6);
    expect(pagePourAncre(apres, 0)).toBe(0);
  });
  it("ancre disparue : page du bloc qui la précède ; avant tout : 0", () => {
    expect(pagePourAncre(avant, 95)).toBe(1);
    expect(pagePourAncre([{ start: 10, page: 2 }], 5)).toBe(0);
    expect(pagePourAncre([], 5)).toBe(0);
  });
});

describe("balayage tactile", () => {
  it("gauche = suivante, droite = précédente", () => {
    expect(directionBalayage(-120, 10)).toBe(1);
    expect(directionBalayage(120, -10)).toBe(-1);
  });
  it("ignore les gestes courts ou verticaux (défilement de la page, sélection)", () => {
    expect(directionBalayage(-30, 0)).toBe(0);
    expect(directionBalayage(-80, 70)).toBe(0);
    expect(directionBalayage(0, 200)).toBe(0);
  });
});

describe("clavier", () => {
  it("flèches, PageUp/PageDown, Début/Fin", () => {
    expect(actionClavier({ key: "ArrowRight" })).toBe("suivante");
    expect(actionClavier({ key: "PageDown" })).toBe("suivante");
    expect(actionClavier({ key: "ArrowLeft" })).toBe("precedente");
    expect(actionClavier({ key: "PageUp" })).toBe("precedente");
    expect(actionClavier({ key: "Home" })).toBe("premiere");
    expect(actionClavier({ key: "End" })).toBe("derniere");
    expect(actionClavier({ key: "a" })).toBeNull();
  });
  it("laisse Maj+flèches (sélection au clavier) et les combinaisons au navigateur", () => {
    expect(actionClavier({ key: "ArrowRight", shiftKey: true })).toBeNull();
    expect(actionClavier({ key: "ArrowLeft", ctrlKey: true })).toBeNull();
    expect(actionClavier({ key: "PageDown", altKey: true })).toBeNull();
    expect(actionClavier({ key: "End", metaKey: true })).toBeNull();
  });
});

describe("feuille A4", () => {
  it("une feuille A4 portrait : la hauteur de la zone, la largeur en découle (297/210)", () => {
    const f = dimensionsFeuille(800, 640);
    expect(f.colonnes).toBe(1);
    expect(f.hauteur).toBe(640);
    expect(f.largeur).toBeCloseTo(640 / RATIO_A4, 5);
    expect(f.largeur / f.hauteur).toBeCloseTo(210 / 297, 3);
  });
  it("grand écran : double page (deux feuilles) quand la zone peut en porter deux, sinon une feuille centrée", () => {
    const double = dimensionsFeuille(1166, 640); // 2 × 452 = 905 ≤ 1166
    expect(double.colonnes).toBe(2);
    expect(double.largeur).toBeCloseTo(2 * 640 / RATIO_A4, 5);
    expect(dimensionsFeuille(905, 640).colonnes).toBe(1); // 2 × 452,55 = 905,10 > 905 : une feuille
    expect(dimensionsFeuille(906, 640).colonnes).toBe(2);
  });
  it("téléphone : plus étroit que la feuille, elle prend toute la largeur", () => {
    const f = dimensionsFeuille(330, 600);
    expect(f.colonnes).toBe(1);
    expect(f.largeur).toBe(330);
    expect(f.hauteur).toBe(600);
  });
  it("fenêtre très basse : on garde une largeur lisible plutôt que les proportions A4", () => {
    const f = dimensionsFeuille(1000, 300); // A4 donnerait 212 px de large
    expect(f.largeur / f.colonnes).toBeGreaterThanOrEqual(LARGEUR_MIN_FEUILLE);
  });
  it("zone très haute et étroite : la feuille ne dépasse jamais la zone", () => {
    const f = dimensionsFeuille(700, 1400);
    expect(f.largeur).toBe(700);
  });
  it("marge proportionnelle, bornée ; zone de texte = feuille moins deux marges", () => {
    const petite = dimensionsFeuille(330, 600);
    const grande = dimensionsFeuille(2400, 3000);
    expect(petite.marge).toBeGreaterThanOrEqual(14);
    expect(grande.marge).toBeLessThanOrEqual(44);
    const z = zoneTexte(dimensionsFeuille(800, 640));
    const f = dimensionsFeuille(800, 640);
    expect(z.largeur).toBeCloseTo(f.largeur - 2 * f.marge, 5);
    expect(z.hauteur).toBeCloseTo(640 - 2 * f.marge, 5);
  });
  it("entrées invalides : feuille vide, sans erreur", () => {
    expect(dimensionsFeuille(0, 600).largeur).toBe(0);
    expect(dimensionsFeuille(600, NaN).largeur).toBe(0);
    expect(dimensionsFeuille(-5, -5).hauteur).toBe(0);
  });
  it("largeur d'une colonne : la page moins les écarts, partagée", () => {
    expect(largeurColonne(1000, 1)).toBe(1000);
    expect(largeurColonne(1000, 2)).toBe((1000 - ECART_PAGES) / 2);
  });
  it("pages : deux colonnes par page, la dernière même à moitié pleine", () => {
    const W = 1000;
    const col = largeurColonne(W, 2);
    const largeur = (n: number) => n * col + (n - 1) * ECART_PAGES; // flux de n colonnes
    expect(nombrePages(largeur(2), W, ECART_PAGES, 2)).toBe(1);
    expect(nombrePages(largeur(3), W, ECART_PAGES, 2)).toBe(2); // 3 colonnes : une page pleine + une demi-page
    expect(nombrePages(largeur(4), W, ECART_PAGES, 2)).toBe(2);
    expect(nombrePages(largeur(13), W, ECART_PAGES, 2)).toBe(7);
    expect(nombrePages(largeur(1), W, ECART_PAGES, 2)).toBe(1);
  });
  it("une colonne par page : comportement inchangé", () => {
    expect(nombrePages(3 * 600 + 2 * ECART_PAGES, 600, ECART_PAGES, 1)).toBe(3);
  });
  it("fin de la dernière page : de quoi atteindre son numéro même incomplète", () => {
    const W = 1000;
    expect(finDernierePage(1, W)).toBe(W);
    expect(finDernierePage(7, W)).toBe(7 * (W + ECART_PAGES) - ECART_PAGES);
    expect(finDernierePage(0, W)).toBe(0);
  });
});
