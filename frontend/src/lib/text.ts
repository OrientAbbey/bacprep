/**
 * Normalise un texte pour une comparaison insensible à la casse ET aux
 * accents ("éducation" doit correspondre à "education"). `toLowerCase()`
 * seul gère déjà Unicode correctement (contrairement à SQLite, voir
 * db.py), mais ne retire pas les accents — on utilise donc en plus la
 * décomposition Unicode NFD (qui sépare une lettre accentuée en sa lettre
 * de base + un signe diacritique combinant) puis on retire ces signes
 * diacritiques (plage U+0300–U+036F).
 */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
