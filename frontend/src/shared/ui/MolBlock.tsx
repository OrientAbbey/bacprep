import { useEffect, useRef, useState } from "react";

/** Styles de dessin d'une molécule, calqués sur examgen (docs/FORMULES.md). */
export type StyleMol = "topologique" | "developpee" | "cram";
export type TailleMol = "petit" | "moyen" | "grand";

const TAILLES: Record<TailleMol, [number, number]> = {
  petit: [220, 150],
  moyen: [300, 200],
  grand: [440, 280],
};

// Thème noir et blanc : impression et PDF lisibles quelle que soit la matière.
const NOIR_ET_BLANC: Record<string, string> = {
  C: "#000", O: "#000", N: "#000", F: "#000", CL: "#000", BR: "#000",
  I: "#000", P: "#000", S: "#000", B: "#000", SI: "#000", H: "#000",
  BACKGROUND: "#fff",
};

let promesseBibliotheque: Promise<{ default: import("smiles-drawer").SmilesDrawerNS }> | null = null;

/** Charge SmilesDrawer à la demande (chunk Vite séparé). Idempotent. */
export function prechargerMol(): Promise<{ default: import("smiles-drawer").SmilesDrawerNS }> {
  if (!promesseBibliotheque) {
    promesseBibliotheque = import("smiles-drawer").catch((erreur: unknown) => {
      promesseBibliotheque = null;
      throw erreur;
    });
  }
  return promesseBibliotheque;
}

interface LigneMol {
  smiles: string;
  legende: string;
}

/** Rend les blocs ```mol (un SMILES par ligne, légende facultative) en SVG. */
export function MolBlock({ contenu, style }: { contenu: string; style: StyleMol }) {
  const conteneur = useRef<HTMLDivElement>(null);
  const [erreurs, setErreurs] = useState<string[]>([]);

  const molecules: LigneMol[] = contenu
    .split("\n")
    .map((ligne) => ligne.trim())
    .filter(Boolean)
    .map((ligne) => {
      const parties = ligne.split(/\s+/);
      return { smiles: parties[0], legende: parties.slice(1).join(" ") };
    });

  useEffect(() => {
    let actif = true;
    setErreurs([]);
    prechargerMol()
      .then(({ default: SmilesDrawer }) => {
        if (!actif || !conteneur.current) return;
        const figures = conteneur.current.querySelectorAll<HTMLElement>("figure[data-smiles]");
        const [largeur, hauteur] = TAILLES.moyen;
        const drawer = new SmilesDrawer.SvgDrawer({
          width: largeur,
          height: hauteur,
          bondLength: style === "developpee" ? 30 : 28,
          padding: 12,
          compactDrawing: false,
          showCarbons: style === "developpee" ? "all" : "default",
          isomeric: true,
          themes: { exam: NOIR_ET_BLANC },
        });
        figures.forEach((figure) => {
          figure.querySelectorAll("svg").forEach((svg) => svg.remove());
          figure.classList.remove("mol-error");
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("width", String(largeur));
          svg.setAttribute("height", String(hauteur));
          figure.insertBefore(svg, figure.firstChild);
          const smiles = figure.getAttribute("data-smiles") ?? "";
          SmilesDrawer.parse(
            smiles,
            (arbre) => {
              if (actif) {
                drawer.draw(arbre, svg, "exam", false);
                figure.classList.add("rendu");
              }
            },
            (e: Error) => {
              svg.remove();
              figure.classList.add("mol-error");
              if (actif) setErreurs((precedentes) => [...precedentes, `${smiles} : ${e.message}`]);
            },
          );
        });
      })
      .catch(() => {
        if (actif) setErreurs(["Bibliothèque de dessin chimique indisponible."]);
      });
    return () => {
      actif = false;
    };
  }, [contenu, style]);

  return (
    <div ref={conteneur} className="mol-bloc my-3 space-y-2">
      {molecules.map((molecule, index) => (
        <figure key={`${molecule.smiles}-${index}`} data-smiles={molecule.smiles} className="mol inline-block text-center">
          {molecule.legende && <figcaption className="text-xs text-ink-soft">{molecule.legende}</figcaption>}
        </figure>
      ))}
      {erreurs.length > 0 && (
        <p role="alert" className="mol-error text-xs text-correction">
          Structure non dessinable — {erreurs.join(" · ")}
        </p>
      )}
    </div>
  );
}
