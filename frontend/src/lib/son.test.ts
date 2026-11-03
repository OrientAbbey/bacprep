import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FauxAudio {
  static instances: FauxAudio[] = [];
  state = "suspended";
  currentTime = 10;
  destination = {};
  demarres: number[] = [];
  resume = vi.fn(() => {
    this.state = "running";
    return Promise.resolve();
  });
  constructor() {
    FauxAudio.instances.push(this);
  }
  createGain() {
    const param = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
    return { gain: param, connect: (x: unknown) => x };
  }
  createOscillator() {
    const demarres = this.demarres;
    return { type: "", frequency: { value: 0 }, connect: (x: unknown) => x, start: (t: number) => demarres.push(t), stop: vi.fn() };
  }
}

function installer(stockage: Record<string, string> = {}) {
  vi.stubGlobal("window", { AudioContext: FauxAudio });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stockage[k] ?? null,
    setItem: (k: string, v: string) => void (stockage[k] = v),
  });
}

describe("alarme sonore continue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FauxAudio.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("réveille le contexte audio au geste utilisateur, bipe tout de suite puis toutes les 0,8 s", async () => {
    installer();
    const { preparerSon, demarrerAlarme, alarmeEnCours } = await import("./son");
    preparerSon();
    expect(FauxAudio.instances).toHaveLength(1);
    expect(FauxAudio.instances[0].resume).toHaveBeenCalled();
    demarrerAlarme();
    expect(alarmeEnCours()).toBe(true);
    expect(FauxAudio.instances[0].demarres).toHaveLength(1);
    vi.advanceTimersByTime(800 * 5);
    expect(FauxAudio.instances[0].demarres).toHaveLength(6);
  });

  it("s'arrête à la demande : plus aucun bip, l'interface est prévenue", async () => {
    installer();
    const { preparerSon, demarrerAlarme, arreterAlarme, alarmeEnCours, surAlarme } = await import("./son");
    const rappel = vi.fn();
    surAlarme(rappel);
    preparerSon();
    demarrerAlarme();
    vi.advanceTimersByTime(1700);
    const avant = FauxAudio.instances[0].demarres.length;
    arreterAlarme();
    expect(alarmeEnCours()).toBe(false);
    expect(rappel).toHaveBeenCalledTimes(2); // début, puis arrêt
    vi.advanceTimersByTime(10_000);
    expect(FauxAudio.instances[0].demarres).toHaveLength(avant);
    arreterAlarme(); // sans effet quand elle ne sonne pas
    expect(rappel).toHaveBeenCalledTimes(2);
  });

  it("s'éteint seule au bout d'une minute si personne ne l'arrête", async () => {
    installer();
    const { preparerSon, demarrerAlarme, alarmeEnCours, DUREE_ALARME_MS } = await import("./son");
    expect(DUREE_ALARME_MS).toBe(60_000);
    preparerSon();
    demarrerAlarme();
    vi.advanceTimersByTime(59_999);
    expect(alarmeEnCours()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(alarmeEnCours()).toBe(false);
    const total = FauxAudio.instances[0].demarres.length;
    expect(total).toBeGreaterThan(70); // un bip toutes les 0,8 s pendant 60 s
    vi.advanceTimersByTime(30_000);
    expect(FauxAudio.instances[0].demarres).toHaveLength(total);
  });

  it("un nouveau démarrage remplace l'alarme en cours (jamais deux cadences superposées)", async () => {
    installer();
    const { preparerSon, demarrerAlarme } = await import("./son");
    preparerSon();
    demarrerAlarme();
    demarrerAlarme();
    expect(FauxAudio.instances[0].demarres).toHaveLength(2); // un bip par démarrage
    vi.advanceTimersByTime(800);
    expect(FauxAudio.instances[0].demarres).toHaveLength(3);
  });

  it("reste silencieuse (et n'affiche rien à arrêter) si le son est coupé, puis sonne une fois réactivé", async () => {
    installer({ "bacprep-son": "off" });
    const { preparerSon, demarrerAlarme, alarmeEnCours, reglerSon, sonActif, arreterAlarme } = await import("./son");
    preparerSon();
    expect(sonActif()).toBe(false);
    demarrerAlarme();
    expect(alarmeEnCours()).toBe(false);
    expect(FauxAudio.instances[0].demarres).toHaveLength(0);
    reglerSon(true);
    demarrerAlarme();
    expect(alarmeEnCours()).toBe(true);
    arreterAlarme();
  });

  it("ne plante pas sans contexte audio préparé ou sans WebAudio", async () => {
    installer();
    const { demarrerAlarme, alarmeEnCours } = await import("./son");
    expect(() => demarrerAlarme()).not.toThrow(); // jamais préparé : silencieux
    expect(alarmeEnCours()).toBe(false);
    vi.resetModules();
    vi.stubGlobal("window", {});
    const sans = await import("./son");
    expect(() => {
      sans.preparerSon();
      sans.demarrerAlarme();
    }).not.toThrow();
    expect(sans.alarmeEnCours()).toBe(false);
  });
});
