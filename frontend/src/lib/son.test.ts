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

describe("alarme sonore", () => {
  beforeEach(() => {
    vi.resetModules();
    FauxAudio.instances = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("joue trois bips espacés après preparerSon (geste utilisateur) et réveille le contexte suspendu", async () => {
    installer();
    const { preparerSon, jouerAlarme } = await import("./son");
    preparerSon();
    expect(FauxAudio.instances).toHaveLength(1);
    expect(FauxAudio.instances[0].resume).toHaveBeenCalled();
    jouerAlarme();
    expect(FauxAudio.instances[0].demarres).toEqual([10, 10.4, 10.8]);
  });

  it("reste silencieuse si le son est coupé, puis rejoue une fois réactivé", async () => {
    installer({ "bacprep-son": "off" });
    const { preparerSon, jouerAlarme, reglerSon, sonActif } = await import("./son");
    preparerSon();
    expect(sonActif()).toBe(false);
    jouerAlarme();
    expect(FauxAudio.instances[0].demarres).toHaveLength(0);
    reglerSon(true);
    jouerAlarme();
    expect(FauxAudio.instances[0].demarres).toHaveLength(3);
  });

  it("ne plante pas sans contexte audio préparé ou sans WebAudio", async () => {
    installer();
    const { jouerAlarme } = await import("./son");
    expect(() => jouerAlarme()).not.toThrow(); // jamais préparé : silencieux
    vi.resetModules();
    vi.stubGlobal("window", {});
    const sans = await import("./son");
    expect(() => {
      sans.preparerSon();
      sans.jouerAlarme();
    }).not.toThrow();
  });
});
