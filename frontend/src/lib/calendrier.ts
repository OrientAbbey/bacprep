import type { Evenement } from "../api/types";

/** Date locale AAAA-MM-JJ → minuit local (évite le décalage UTC de `new Date("AAAA-MM-JJ")`). */
export function dateLocale(iso: string): Date {
  const [a, m, j] = iso.split("-").map(Number);
  return new Date(a, m - 1, j);
}

/** Jours entre aujourd'hui et la date (0 = aujourd'hui, négatif = passé). */
export function joursAvant(iso: string, maintenant: Date = new Date()): number {
  const auj = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate());
  return Math.round((dateLocale(iso).getTime() - auj.getTime()) / 86_400_000);
}

/** Prochain examen à venir (ou en cours) parmi les événements. */
export function prochainExamen(evenements: Evenement[], maintenant: Date = new Date()): Evenement | null {
  return (
    evenements
      .filter((e) => e.type === "examen" && joursAvant(e.date_fin || e.date_debut, maintenant) >= 0)
      .sort((a, b) => a.date_debut.localeCompare(b.date_debut))[0] ?? null
  );
}

export function formaterDate(iso: string): string {
  return dateLocale(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}
