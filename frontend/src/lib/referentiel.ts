// Miroir frontend de backend/app/core/referentiel.py — classifications
// indicatives du système scolaire camerounais (secondaire complet).

export const CLASSES_SECONDAIRE: { code: string; label: string }[] = [
  { code: "6e", label: "6e" },
  { code: "5e", label: "5e" },
  { code: "4e", label: "4e" },
  { code: "3e", label: "3e" },
  { code: "2nde", label: "2nde" },
  { code: "1ere", label: "1ère" },
  { code: "terminale", label: "Terminale" },
];

export function classeLabel(code: string): string {
  return CLASSES_SECONDAIRE.find((c) => c.code === code)?.label ?? code;
}

export const NIVEAUX = [
  { code: "SECONDAIRE", label: "Secondaire" },
  { code: "PRIMAIRE", label: "Primaire (réservé)" },
] as const;

/** Types d'évaluation connus — miroir de backend/app/core/referentiel.py:EVALUATIONS */
export const EVALUATIONS: string[] = [
  "CEP", "BEPC", "PROBATOIRE", "BAC", "SEQUENCE 1", "SEQUENCE 2", "SEQUENCE 3",
  "COMPOSITION TRIMESTRIELLE", "EXAMEN BLANC", "CONCOURS", "AUTRE",
];

/** Séries/filières connues — miroir de backend/app/core/referentiel.py:SERIES_CONNUES */
export const SERIES_CONNUES: string[] = ["A", "C", "D", "E", "TI", "F", "G", "ESP"];
