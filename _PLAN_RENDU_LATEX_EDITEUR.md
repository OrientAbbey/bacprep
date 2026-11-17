# Plan — Rendu LaTeX/KaTeX et éditeur unifiés (fusion examgen)

Statut : **plan à valider avant implémentation**. Date : 17 novembre 2026.
Objectif : une seule configuration de rendu et de saisie des formules (maths, physique, chimie), partagée par **toutes** les zones du projet qui affichent ou éditent du Markdown, en conservant notre normalisation existante et en y intégrant les apports d'examgen — **y compris SMILES**.

---

## 1. Principe directeur

- **On garde** `frontend/src/lib/latex.ts` (normalisation `\( \)`, `\[ \]`, `\begin{...}` nu, isolation `$$`) — plus robuste que l'approche d'examgen pour le texte généré par IA, et préservant les offsets source du lecteur.
- **On centralise** les options KaTeX et les outils d'insertion dans un module partagé, au lieu de les répéter (`MarkdownContent.tsx`, `atelier.ts`, futurs éditeurs).
- **On importe d'examgen** : extension **mhchem**, barre d'outils **élargie** (maths + physique + chimie), blocs ```mol``` / **SMILES**.
- **Import différé (à la demande) : OUI, c'est possible**, et c'est même la stratégie retenue. Voir §4 (recherche faite).
- **On n'importe pas** le rendu serveur d'examgen (`POST /api/admin/preview`) : notre aperçu client utilise déjà le même composant que l'élève, donc rendu identique garanti.

---

## 2. État des lieux — où le rendu est utilisé

### 2.1 Zones de **rendu** (toutes passent déjà par `MarkdownContent`)

| Zone | Fichier | Variante |
|---|---|---|
| Lecteur d'épreuve (défilement + paginé) | `pages/ViewerPage.tsx` | `epreuve`, `trackSourcePositions` |
| Épreuve composée (banque), sujet/corrigé, entraînement | `pages/EntrainementPage.tsx` | `epreuve` |
| Export PDF (sujet, corrigé, les deux) | `components/ExportPdf.tsx` | `epreuve` |
| Aperçu de l'éditeur d'épreuves | `pages/admin/shared.tsx` (`ApercuTempsReel`) | `epreuve` |
| Aperçu des gabarits validés | `pages/admin/GabaritsPanel.tsx` | `epreuve` |
| Aperçu de l'atelier IA | `components/AtelierExercicesModal.tsx` | `epreuve` |
| Bulles de discussion, contexte assistant, notes, assistant global | `AssistantPanel.tsx`, `ChatParts.tsx`, `NoteEditor.tsx`, `AdminAssistantGlobal.tsx` | `chat` |

→ Toutes ces zones bénéficieront **automatiquement** de la configuration centralisée (mhchem, SMILES, cohérence des options) sans modification individuelle.

### 2.2 Zones de **saisie** (où la barre d'outils sera ajoutée)

| Zone | Fichier | État actuel | Cible |
|---|---|---|---|
| Éditeur d'épreuves | `EpreuvesPanel.tsx` → `ContentBlock` (`shared.tsx`) | Aperçu temps réel, import `.md`, images — **pas de barre de formules** | + barre élargie |
| Éditeur de la banque | `BanquePanel.tsx:466-467` | **Deux `<textarea>` nus**, aucun aperçu | + barre élargie + aperçu |
| Atelier IA | `AtelierExercicesModal.tsx` | Champ `consignes` libre | Inchangé (contenu généré contrôlé puis inséré) |
| Chat / notes / signalement | divers | Champs libres | **Inchangé** — décision confirmée |

### 2.3 Validation des formules

| Zone | Fichier | État |
|---|---|---|
| Atelier IA | `lib/atelier.ts` → `verifierFormules()` | Duplique les options KaTeX — à aligner sur la config partagée, **après chargement de mhchem** pour que `\ce{}` soit validé correctement |

---

## 3. Charge de travail — recherche effectuée (confiance)

### 3.1 mhchem (`\ce`, `\pu`) — import différé possible ✅

- L'extension est **séparée du cœur KaTeX** (`katex/contrib/mhchem/mhchem.js`, ~68 Ko non minifié).
- Le fichier legacy `contrib/mhchem/mhchem.js` référence le global `katex` nu, mais **le build ESM `katex/contrib/mhchem` (`dist/contrib/mhchem.mjs`) importe lui-même le même module katex** : `await import("katex/contrib/mhchem")` fonctionne directement sous Vite, sans global.
- Stratégie retenue : `chargerExtensions()` → `import()` dynamique idempotent → chunk séparé chargé **au premier besoin seulement**, macros enregistrées globalement pour tous les rendus KaTeX ultérieurs.
- Ordre de chargement respecté : KaTeX avant mhchem (sinon `__defineMacro` n'existe pas) — documenté dans le module.
- Couverture mhchem vérifiée (manuel officiel) : formules moléculaires/atomiques/ioniques `\ce{H2O}`, charges `\ce{SO4^2-}`, isotopes `\ce{^{227}_{90}Th+}`, coefficients `\ce{2 H2O}`, flèches de réaction `\ce{A ->[I-] B}`, états `\ce{H2O(l)}`, unités physiques `\pu{123 kJ//mol}`, notation scientifique `\pu{1.2e3 kJ}`. Liaisons `\ce{CH3-CH2-OH}` pour les **formules semi-développées** textuelles.
- Limite : mhchem ne dessine **pas** de structures — c'est le rôle de SMILES §3.2.

### 3.2 SMILES / SmilesDrawer — import différé possible ✅

- Bibliothèque **MIT**, v2.4.1, ~200 Ko, `SmilesDrawer.parse(smiles, onSuccess, onError)` + `SvgDrawer` (SVG noir et blanc pour l'impression).
- Styles déjà identifiés dans examgen : **topologique** (squelette), **développée** (`showCarbons: "all"`), **Cram** (stéréochimie via SMILES isomérique `isomeric: true`). Options supplémentaires utiles : `experimentalSSSR` (cycles pontés), `getMolecularFormula()` (formule brute calculée).
-examgen charge déjà le script **uniquement quand un bloc ```mol``` est présent** (`math.js:loadChem`) : la cinématique est prouvée. Chez nous : `await import("smiles-drawer")` dans un composant `MolBlock` → chunk séparé chargé au premier bloc SMILES.
- **Piège d'impression** : le rendu SMILES est asynchrone. La fenêtre d'impression (`setTimeout 300 ms` dans `EntrainementPage`, `ExportPdf`) doit **attendre le chargement** (précharger dès l'affichage de l'épreuve, ou `await` dans le gestionnaire d'impression) sous peine d'imprimer un bloc vide. À couvrir par la recette navigateur.
- **Décision** : **on importe SMILES** (la chimie est une cible explicite). Formats pris en charge : formule brute (texte `\ce{}` + `getMolecularFormula()`), formule moléculaire/atomique/ionique (`\ce{}`), semi-développée (`\ce{CH3-CH2-OH}` ou dessin SMILES), structures développées/Cram (` ```mol developpee|cram `).

### 3.3 KaTeX strict — décision

- **On garde `strict: "ignore"`** en production (comportement actuel, tolérant). Les avertissements restent limités à l'atelier IA (`verifierFormules`, `throwOnError: true`).

---

## 4. Architecture cible

Nouveau module : **`frontend/src/lib/renduMath.ts`** (single source of truth)

```ts
export const KATEX_OPTIONS        // throwOnError:false, strict:"ignore", trust:false,
                                  // output:"htmlAndMathml" — macro \ce/\pu disponibles après chargement
export const KATEX_OPTIONS_STRICT // pour verifierFormules() (throwOnError:true)
export async function chargerExtensions(): Promise<void>  // mhchem (différé), puis SMILES si besoin
export function normaliserPourRendu(markdown, { preserverOffsets }: boolean): string
export function verifierFormule(formule, bloc): void
export const OUTILS_FORMULES      // groupes Maths / Physique / Chimie / Structures
```

### Barre d'outils élargie (au lieu des 7 boutons d'examgen)

Groupes avec en-têtes accessibles (`role="group"`, `aria-label`), rendus dans un conteneur défilable horizontally pour ne pas déborder sur mobile :

**Maths** — `u₁` `xⁿ` `a⁄b` `√x` `√[n]{x}` `∑` `∏` `∫` `lim` `∂` `( )` `[ ]` `{ }` matrice `pmatrix`, système `cases`, `|x|`, `±`, `≤ ≥`, `≈`, `∈`, `∞`, `α β γ θ λ μ π σ Ω`, `→`, `⟹`

**Physique** — `\vec{F}`, `\Delta`, `\lambda`, `\omega`, `\hbar`, `\rho`, `\sigma`, `\phi`, `\theta`, `\partial`, `\int_{a}^{b}`, `\pu{…}` (unités), `\pu{1.2e3 kJ}`, `\pu{123 kJ//mol}`, `E=mc^2`

**Chimie** — `\ce{H2O}` (moléculaire), `\ce{Na+}` / `\ce{SO4^2-}` (atomique/ionique), `\ce{^{227}_{90}Th+}` (isotope), `\ce{2 H2O}` (coefficient), `\ce{CH3-CH2-OH}` (semi-développée), `\ce{CO2 + C -> 2 CO}` (équation), `\ce{H2O(l)}` (état), `\ce{A ->[I-] B}` (flèche annotée), `\pu{g.mol-1}`

**Structures** — bouton `🧪 Molécule` insérant :
```
```mol topologique
CCO éthanol
```
```
avec un sélecteur de style (`topologique`, `developpee`, `cram`) et taille (`petit`, `moyen`, `grand`).

Chaque outil insère le snippet **à la position du curseur** en sélectionnant le paramètre à remplacer (`insertAt` d'examgen), reste accessible au clavier (`<button type="button">`, `title`, `aria-label`).

---

## 5. Lots de travail (commits atomiques)

- [x] **Lot 1 — Configuration partagée + mhchem différé.** `lib/renduMath.ts` centralise les options et la normalisation ; `chargerExtensions()` charge `katex/contrib/mhchem` en `import()` dynamique (le build ESM importe katex lui-même — aucun global nécessaire) ; `MarkdownContent` et `atelier.ts` consomment la config et préchargent mhchem.
- [x] **Lot 2 — Barre d'outils élargie.** `FormulesToolbar` (4 groupes, ~59 outils : maths, physique, chimie, structures) accessible au clavier, ajoutée à `ContentBlock` et à l'éditeur de banque ; `FormatAttendu` enrichi. Console admin en français (convention du back-office) : aucun `en.json` à modifier.
- [x] **Lot 3 — Aperçu de la banque.** Les deux textareas nus sont remplacés par un mini-éditeur **Texte + rendu en temps réel côte à côte** utilisant `MarkdownContent` : rendu identique à l'élève.
- [x] **Lot 4 — SMILES (import différé).** `MolBlock` (renderer `code` pour `language-mol`), `await import("smiles-drawer")` en chunk séparé (190 Ko), 3 styles + tailles, thème noir et blanc pour l'impression, gestion d'erreur, **préchargement avant `window.print()`** dans `EntrainementPage` et `ExportPdf`. Dépendance `smiles-drawer` ajoutée.
- [x] **Lot 5 — Tests.** 305 tests verts (dont `renduMath.test.ts` : options, outils, mhchem idempotent, `\ce{}`/`\pu{}`) et recette navigateur **10/10** dont un scénario chimie (formule mhchem + structure SMILES rendues chez l'élève et en zone d'impression).
- [x] **Lot 6 — Recette et clôture.** `npm test` (305), `npm run build` OK (chunk `smiles-drawer` bien séparé), recette 10/10, diff relu, fichiers non suivis préservés.

---

## 6. Où chaque modification sera utilisé — récapitulatif

| Modification | Utilisée dans |
|---|---|
| `KATEX_OPTIONS` centralisé | `MarkdownContent` → **toutes les zones de rendu** (§2.1) + aperçus + ExportPdf |
| Extension **mhchem** (différée) | Idem : `\ce{}`/`\pu{}` dans épreuve, corrigé, banque, chat, notes, PDF ; validation atelier alignée |
| `chargerExtensions()` | `MarkdownContent` (au montage), `atelier.ts` (avant validation), gestionnaire d'impression |
| `normaliserPourRendu` | `MarkdownContent` (`epreuve` + `chat`), `streaming.test.ts` |
| `FormulesToolbar` (4 groupes) | Éditeur d'épreuves (`ContentBlock`) + éditeur de banque (`BanquePanel`) |
| Mini-éditeur avec aperçu | Éditeur de banque uniquement |
| `MolBlock` + SmilesDrawer (différé) | Toutes les zones de rendu via `MarkdownContent`, aperçus admin, atelier, PDF |

---

## 7. Décisions tranchées

1. **SMILES** : **importé** (chimie cible explicite), en chargement différé.
2. **KaTeX strict** : on garde `strict: "ignore"` en production ; avertissements dans l'atelier IA seulement.
3. **Barre d'outils dans le chat/notes** : **non** (pas de formules attendues).
4. **Rendu serveur examgen** : **non importé** (notre aperçu client partage le composant de l'élève).

---

## 8. Stratégie Git / PR

- Branche unique : **`feature/rendu-latex-editeur`** depuis `refonte`.
- Un commit par lot (atomique, `feat:` / `refactor:` / `test:`), **aucun push intermédiaire**.
- **Une seule PR commune à la fin** (`refonte ← feature/rendu-latex-editeur`).
- Avant la PR : tests verts, build OK, relecture du diff, aucun secret, aucun fichier non suivi ajouté par erreur.

---

## 9. Risques et garde-fous

- **Régression de rendu** : options centralisées équivalentes à l'actuel — tests de non-régression `latex.test.ts` et recette KaTeX existante (`e2e/e2e.mjs`).
- **Offsets du lecteur** : `preserverOffsets: true` conservé dans `ViewerPage` (sélection de texte).
- **Sécurité** : `trust: false` conservé, HTML brut non rendu ; SMILES = dessin SVG uniquement, jamais d'exécution de script, erreur affichée en clair.
- **Impression asynchrone** : le chunk SMILES doit être chargé avant `window.print()` (préchargement) — vérifié en recette navigateur.
- **i18n** : toute nouvelle chaîne ajoutée à `en.json` (le typage `Cle` fait échouer la compilation sinon).
- **Taille du bundle** : mhchem et smiles-drawer restent hors du bundle principal grâce au `import()` dynamique — à vérifier dans la sortie de build.
