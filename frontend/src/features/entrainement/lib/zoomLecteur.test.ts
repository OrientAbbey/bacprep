import { afterEach, describe, expect, it, vi } from "vitest";
import { PALIERS, ZOOM_MAX, ZOOM_MIN, borner, memoriserZoom, palierVoisin, zoomInitial, zoomPince } from "./zoomLecteur";

describe("paliers A−/A+", () => {
  it("descendent jusqu'à 40 % et montent jusqu'à 200 %, sans jamais sortir de ces bornes", () => {
    expect(ZOOM_MIN).toBe(0.4);
    expect(ZOOM_MAX).toBe(2);
    expect(PALIERS[0]).toBe(ZOOM_MIN);
    expect(PALIERS[PALIERS.length - 1]).toBe(ZOOM_MAX);
    let z = 1;
    for (let i = 0; i < 30; i++) z = palierVoisin(z, -1);
    expect(z).toBe(ZOOM_MIN);
    for (let i = 0; i < 30; i++) z = palierVoisin(z, 1);
    expect(z).toBe(ZOOM_MAX);
  });
  it("partent d'une valeur entre deux paliers (issue d'un pincement) vers le palier voisin dans le bon sens", () => {
    expect(palierVoisin(1.07, 1)).toBe(1.15);
    expect(palierVoisin(1.07, -1)).toBe(1);
    expect(palierVoisin(1, -1)).toBe(0.9);
    expect(palierVoisin(1, 1)).toBe(1.15);
  });
});

describe("pincement", () => {
  it("multiplie le zoom de départ par le rapport des écartements, borné", () => {
    expect(zoomPince(1, 100, 150)).toBeCloseTo(1.5);
    expect(zoomPince(1, 100, 50)).toBeCloseTo(0.5);
    expect(zoomPince(1.5, 100, 400)).toBe(ZOOM_MAX);
    expect(zoomPince(0.5, 100, 10)).toBe(ZOOM_MIN);
    expect(zoomPince(1.2, 0, 80)).toBe(1.2);
    expect(borner(99)).toBe(ZOOM_MAX);
  });
});

describe("zoom mémorisé", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (m: Record<string, string>) => vi.stubGlobal("localStorage", { getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => void (m[k] = v) });
  it("vaut 100 % par défaut, se mémorise, se borne, ignore une valeur invalide et résiste à l'absence de stockage", () => {
    const m: Record<string, string> = {};
    stub(m);
    expect(zoomInitial()).toBe(1);
    memoriserZoom(0.5);
    expect(zoomInitial()).toBe(0.5);
    m["bacprep-zoom-lecteur"] = "9";
    expect(zoomInitial()).toBe(ZOOM_MAX);
    m["bacprep-zoom-lecteur"] = "abc";
    expect(zoomInitial()).toBe(1);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("bloqué"); }, setItem: () => { throw new Error("bloqué"); } });
    expect(zoomInitial()).toBe(1);
    expect(() => memoriserZoom(0.7)).not.toThrow();
  });
});
