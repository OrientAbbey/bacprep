/** Copie `texte` TEL QUEL (espaces, retours à la ligne et marques Markdown compris) dans le
 * presse-papiers. `navigator.clipboard` exige un contexte sécurisé (https) : sinon repli sur une
 * zone de saisie temporaire et `execCommand("copy")`. Renvoie false si rien n'a pu être copié. */
export async function copierTexte(texte: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(texte);
      return true;
    }
  } catch {
    /* permission refusée : on tente le repli */
  }
  try {
    const zone = document.createElement("textarea");
    zone.value = texte;
    zone.setAttribute("readonly", "");
    zone.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.append(zone);
    zone.select();
    const ok = document.execCommand("copy");
    zone.remove();
    return ok;
  } catch {
    return false;
  }
}
