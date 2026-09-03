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
