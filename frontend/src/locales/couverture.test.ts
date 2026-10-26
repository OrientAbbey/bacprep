import { expect, it } from "vitest";
import en from "./en.json";

// Interface élève uniquement : la console admin reste volontairement en français.
const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.*", "!../pages/admin/**", "!../**/*[Aa]dmin*", "!../i18n.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

it('chaque t("…") de l\'interface élève a sa traduction anglaise', () => {
  expect(Object.keys(sources).length).toBeGreaterThan(20);
  const manquantes: string[] = [];
  for (const [fichier, code] of Object.entries(sources)) {
    for (const m of code.matchAll(/\bt\(\s*"((?:[^"\\\n]|\\.)*)"/g)) {
      const cle = JSON.parse(`"${m[1]}"`) as string;
      if (!(cle in en)) manquantes.push(`${fichier} : ${cle}`);
    }
  }
  expect(manquantes).toEqual([]);
});
