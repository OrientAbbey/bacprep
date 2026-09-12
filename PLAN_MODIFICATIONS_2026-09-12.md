# Plan de modifications — 12 septembre 2026

Plan complet des 10 modifications demandées. Chaque chantier est listé avec ses
étapes ; chaque étape est cochée (`[x]`) une fois réellement réalisée et
vérifiée (build frontend + tests frontend/backend).

Légende : `[x]` réalisé · `[ ]` à faire.

---

## 1. Supprimer le redimensionnement de l'assistant + tout le code mort

- [x] Retirer la poignée de redimensionnement (drag) du tiroir bureau
      (`ViewerPage.tsx` : `assistantWidth`, `isDragging`, `dragOrigin`,
      persistance `localStorage` « assistant-panel-width ») — supprimé.
- [x] Retirer l'état et les handlers de dragToResize restés en mort.
- [x] Supprimer le **mode plein écran centré (`expanded`)** : état, bouton
      Maximize2/Minimize2, overlay `z-[59]`, variante `containerClass` —
      seuls restent les 2 modes validés : **tiroir droit (bureau)** et
      **feuille modale (mobile)**.
- [x] Nettoyer le commentaire d'échelle z-index dans `index.css`
      (suppression des références `z-[59]`/`z-[60]` « modale assistant
      étendue »).

## 2. « Tuteur IA Prep » ne doit plus chevaucher la barre d'en-tête

- [x] Lecteur d'épreuve à **hauteur fixe** `h-[calc(100dvh-7rem)]` : rangées
      d'en-tête fixes (`shrink-0`), zone de lecture en défilement **interne**
      (`absolute inset-0 overflow-y-auto`) — plus aucun dépassement par-dessus
      le header sticky quand on défile.
- [x] Le tiroir bureau est aligné sur exactement la même hauteur que le
      lecteur (`inset-y-0` / colonne de la même rangée flex) — jamais au-delà.

## 3. Transformer « Tuteur IA Prep » en drawer latéral droit

- [x] Bureau : panneau placé **à droite du lecteur**, largeur `w-[min(560px,46vw)]`,
      hauteur = hauteur du lecteur.
- [x] **Le drawer ne recouvre pas l'épreuve en affichage web** : c'est une
      colonne sœur du lecteur (rangée flex), pas un overlay par-dessus — le
      contenu reste intégralement lisible, le lecteur s'ajuste (`flex-1 min-w-0`).
- [x] Mobile : feuille **plein écran sans rebord** (`fixed inset-0`, plus de
      `top-16`/`rounded-t-lg` qui faisaient chevaucher l'en-tête).
- [x] Fermeture : bouton X, Échap, ou bouton lanceur.

## 4. Barres de défilement verticales à côté des formules + rendu LaTeX

- [x] `index.css` : `.prose-chat .katex-display` passe en `overflow-y: hidden`
      (+ padding bas) — plus de barre verticale parasite à gauche des formules
      (un `overflow-y: visible` à gauche d'un `overflow-x: auto` est recalculé
      en `auto` par le navigateur).
- [x] `lib/latex.ts` réécrit en scanner caractère par caractère :
      `\[...\]`→`$$...$$`, `\(...\)`→`$...$`, environnements `\begin{...}` nus
      (aligned/array/matrix/cases…) enveloppés UNE seule fois, `\\[2pt]`
      jamais confondu avec un délimiteur `\[`, blocs `$$` jamais re-scannés.
- [x] Cas couverts par les tests (`latex.test.ts`, 18 tests dont) : `\tfrac`,
      `\begin{array}{c|cccc}`, `\begin{aligned}` multiligne, `\\[2pt]`,
      `\nearrow/\searrow`, enveloppe unique (pas de `$$$$`).

## 5. Anti-capture d'écran sur mobile (cahier des charges)

- [x] CAHIER_DES_CHARGES consulté (Module 4, ~l.218-224 & l.473-474) :
  - **Android** : `FLAG_SECURE` → exige un wrapper natif/Capacitor ; aucun
    wrapper natif dans le dépôt (app web pure) → non applicable en l'état.
  - **Web** : aucun blocage natif possible — le **filigrane dynamique** est la
    seule protection réelle (assumée comme telle par le cahier des charges).
- [x] Filigrane dynamique déjà en place sur le lecteur (`Watermark.tsx`,
      `<pattern>` SVG répété automatiquement) avec email + date/heure.
- [x] Copie système désactivée sur la zone d'épreuve (`onCopy` → `preventDefault`),
      le menu contextuel bloqué sur mobile (`onContextMenu` → `preventDefault`) :
      la sélection ne peut que déclencher la barre d'actions (Voir chantier 6).

## 6. Mobile : bouton Admin + barre latérale + menu de sélection correct

- [x] `Layout.tsx` : **burger mobile** (bouton ☰) ouvrant un **tiroir latéral**
      (Accueil, Abonnement, Admin si admin, recherche, compte) — le lien Admin
      est désormais visible sur mobile pour les comptes admin.
- [x] Barre de sélection « Demander » / « Prendre une note » sur mobile :
      écoute du `selectionchange` global (la sélection par long-appui ne
      déclenche pas `mouseup`), `onContextMenu` bloqué → le menu natif Chrome
      ne s'ouvre plus, c'est la SelectionBar qui apparaît.

## 7. Hauteur fixe d'une page pour le lecteur et l'assistant + marge modale

- [x] Lecteur = hauteur d'écran fixe (hors header/layout), défilement interne.
- [x] Assistant = **même hauteur** que le lecteur (tiroir bureau aligné,
      feuille mobile plein écran).
- [x] Marge extérieure supprimée en mode modale : feuille mobile `fixed inset-0`
      sans rebord (plus de marge haut `top-16`).

## 8. Suivi d'activité : distinguer mobile et ordinateur

- [x] `AuthProvider.tsx` : `detectPlatform()` → envoie `platform: "mobile"|"web"`
      aux login mock et Google (UA mobile OU tactile + écran < 1024 px).
- [x] `backend/app/routers/me.py` : libellés « Connexion à ton compte (mobile) »
      / « Connexion à ton compte (ordinateur) » selon `session.platform`.

## 9. Login admin & gouvernance

- [x] **Afficher/masquer le jeton** : bouton œil (Eye/EyeOff) sur le champ jeton
      de `AdminPage.tsx`.
- [x] **Bug « renvoi immédiat au formulaire »** : après login, `loadStats("actif")`
      est appelé de suite (le tableau de bord n'est plus vide) et `handle401` ne
      laisse plus le formulaire réapparaître illégitimement.
- [x] **Formulaire nettoyé** : `handle401`/`onSessionExpiree` vident jeton +
      email + erreur ; les panneaux signalent l'expiration via l'événement
      `admin:session-expiree` (fini le `window.location.reload()` qui reparsait
      direct au formulaire).
- [x] **Promouvoir un utilisateur en admin** : tableau `UtilisateursPanel` —
      badges « Admin délégué » / « Admin racine », boutons Promote/Démouvoir,
      réservés coté serveur au root (403 sinon) ; les admins échappent à
      bannir/supprimer.
- [x] **ADMIN_EMAILS → ADMIN_ROOT** : `admin_session.root_emails()` lit
      `ADMIN_ROOT` (alias historique `ADMIN_EMAILS`) ; `allowed_emails(db)` =
      ROOT ∪ promus (`users.role="admin"`) ; le root est aligné en base à son
      login et ne peut ni être banni, ni supprimé, ni révoqué ; migration
      idempotente de la colonne `users.role` au démarrage (`main.py`).

## 10. Design : occuper l'espace au lieu de tout centrer

- [x] `Layout.tsx` : suppression de `max-w-6xl` sur l'en-tête et le `<main>`
      → **pleine largeur** (`w-full`, padding `md:px-6 lg:px-8`), le contenu
      s'étale sur tout l'écran ; seul le contenu de chaque page garde sa grille.
- [x] Vérifié : accueil/catalogue/profil profitent de la largeur totale sans
      colonne centrale blanche.

---

## Vérifications

- [x] `npm run test` (frontend) — 21 tests ✓
- [x] `npm run build` (frontend) — build prod ✓
- [x] `pytest` (backend, `.venv`) — 84 tests ✓