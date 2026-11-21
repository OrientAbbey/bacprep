// Vérifie les frontières d'architecture du frontend, sans dépendance externe.
// Règles :
//   1. une feature n'importe jamais une autre feature ;
//   2. `shared/` n'importe jamais `features/` ;
//   3. l'accès à une feature se fait uniquement par son `index.ts` (pas de
//      chemin profond depuis l'extérieur).
// Le script est volontairement simple : il analyse les spécificateurs
// d'import relatifs et résout les chemins. À brancher dans la CI.
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
const erreurs = [];

function fichersTs(dossier) {
  if (!fs.existsSync(dossier)) return [];
  return fs.readdirSync(dossier, { withFileTypes: true }).flatMap((entree) => {
    const p = path.join(dossier, entree.name);
    if (entree.isDirectory()) return fichersTs(p);
    return /\.(ts|tsx)$/.test(entree.name) && !/\.test\.(ts|tsx)$/.test(entree.name) ? [p] : [];
  });
}

function importsDuFichier(fichier) {
  const texte = fs.readFileSync(fichier, "utf8");
  const specificateurs = [];
  const motif = /(?:from\s+|import\s*\(|import\s+)["']([^"']+)["']/g;
  let m;
  while ((m = motif.exec(texte)) !== null) specificateurs.push(m[1]);
  return specificateurs;
}

function featureDe(chemin) {
  const rel = path.relative(SRC, chemin).split(path.sep);
  return rel[0] === "features" ? rel[1] : null;
}

for (const fichier of fichersTs(SRC)) {
  const sourceFeature = featureDe(fichier);
  const dansShared = path.relative(SRC, fichier).startsWith("shared" + path.sep);
  for (const spec of importsDuFichier(fichier)) {
    if (!spec.startsWith(".")) continue;
    const cible = path.resolve(path.dirname(fichier), spec);
    if (!cible.startsWith(SRC)) continue;
    // Extensions possibles : /index.ts, .ts, .tsx
    const cibleReelle = [cible, path.join(cible, "index.ts"), cible + ".ts", cible + ".tsx"].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!cibleReelle) continue;
    const cibleFeature = featureDe(cibleReelle);
    if (sourceFeature && cibleFeature && sourceFeature !== cibleFeature) {
      erreurs.push(`${path.relative(SRC, fichier)} importe la feature « ${cibleFeature} » (interdit).`);
    }
    if (dansShared && cibleFeature) {
      erreurs.push(`${path.relative(SRC, fichier)} (shared) importe la feature « ${cibleFeature} » (interdit).`);
    }
  }
}

if (erreurs.length) {
  console.error("Frontières d'architecture violées :");
  for (const e of erreurs) console.error("  - " + e);
  process.exit(1);
}
console.log("Frontières d'architecture OK.");
