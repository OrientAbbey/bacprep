# Plan — unification des assistants du back-office (Épreuves + Banque/autres onglets)

## Objectif

Remplacer les **deux assistants admin** actuels par **un seul assistant visuel et un seul tiroir**, dont le comportement s'adapte à l'onglet :

- **Épreuves** : co-rédaction du sujet/corrigé (protocole `remplacer-sujet:N`, `modification-sujet`, `modification-form`), application automatique optionnelle, annulation, régénération.
- **Banque et autres onglets** : ouverture/remplissage du formulaire (`formulaire`, `edition`) et plan d'actions signé soumis à approbation (`Tout approuver`, `Rejeter`, `Ignorer`, édition d'une action).

Les prompts LLM, les garanties de sécurité et les deux stratégies d'édition restent **inchangées sur le fond** : on fusionne l'interface et le câblage, pas les règles métier.

## Contraintes / non-régressions

- Aucune écriture serveur sans approbation explicite (plan signé `/proposition` + `/commit`, liste blanche d'outils).
- Aucune modification du formulaire sans possibilité d'annulation.
- conversations persistées sous les mêmes clés : `epreuve_id` / `brouillon:<id>` (Épreuves) et `onglet:<nom>` (autres onglets).
- Conserver les fonctionnalités de chat déjà présentes côté Épreuves : reconnexion SSE automatique, file d'attente, édition inline + relance, horodatage, bascule « Appliquer automatiquement » (localStorage `bacprep-assistant-admin-auto`).
- Conserver le contexte publié par `BanquePanel` lu **au moment de l'envoi** (`publierContexteAdmin`).
- Un seul lanceur flottant, visible et sans débordement à 1280 px et sur mobile.

## Décisions UI/UX (validées)

- **Base visuelle** : le tiroir de `AdminAssistantPanel` (dialogue « Tuteur IA Prep ») devient le tiroir unique.
- **Gardé de l'assistant Épreuves** : `ChatBubble`/`MessageComposer`/`Avatar` et la signature, reconnexion SSE avec backoff, file d'attente, édition inline d'une question + régénération, relance « Réessayer », horodatage HH:MM, focus auto, Échap, « Nouvelle conversation », bandeau de contexte, bascule « Appliquer automatiquement », « Appliquer au sujet », « Annuler la dernière application », signalement des champs/onglets modifiés, protocole `remplacer-sujet` / `modification-sujet` / `modification-form`.
- **Gardé de l'assistant global (reporté dans le tiroir unique)** : cartes de plan (`LIBELLES_OUTILS`, arguments JSON visibles avant confirmation, `Tout approuver`, `Rejeter`, `Ignorer`, `Éditer` → nouveau jeton, états `attente/en-cours/fait/ignoree/erreur`), encarts « Formulaire ouvert » et « Champs remplis » avec « Annuler ces modifications », bandeau « ONGLET : <NOM> », mécanisme `publierContexteAdmin`/`lireContexteAdmin`/`ouvrirFormulaireAdmin`/`appliquerChampsAdmin` avec `flushSync`.
- **Supprimé (doublon)** : le second lanceur flottant « Assistant » et son tiroir `<aside aria-label="Assistant du back-office">`, la textarea simple du global.
- **Libellés** : un seul lanceur flottant, texte visible « Assistant », `aria-label="Ouvrir l'assistant admin"` sur tous les onglets ; champ de saisie unique `aria-label="Question à Tuteur IA Prep"` ; les sélecteurs E2E du mode agent seront mis à jour, sans affaiblir les assertions.
- **Bandeau de contexte unique** : « CONTEXTE : ÉPREUVE EN COURS … » en mode édition, « ONGLET : <NOM> » en mode agent.
- **Navigation pendant la discussion** : pas de fond bloquant en mode agent (l'admin peut changer d'onglet tiroir ouvert) ; le fond assombri reste en mode édition. Quand l'onglet Épreuves devient inactif, son tiroir se ferme (`actif={tab === "epreuves"}`) pour éviter deux dialogues dans le DOM.

## Architecture cible

- `AdminAssistantPanel.tsx` devient **l'unique** assistant. Il reçoit un `mode` implicite déduit de l'onglet :
  - `onglet === "epreuves"` → mode **édition** (prompt `build_admin_prompt`, `agent: false`, snapshot formulaire, application au texte) ;
  - sinon → mode **agent** (`prompt_onglet`, `agent: true`, événements `formulaire`/`edition`/`proposition`, plan).
- **Décision d'implémentation** : un seul composant `AdminAssistantPanel`, monté à deux endroits mutuellement exclusifs — dans `EpreuvesPanel` (mode édition, avec ses props directes) et dans `AdminPage` pour les autres onglets (mode agent). Un seul lanceur visible à la fois (le panneau Épreuves est dans une div masquée quand un autre onglet est actif). Cela évite un registre réactif fragile pour le snapshot du formulaire tout en donnant une UI/UX identique.
- `AdminPage.tsx` continue de monter l'assistant pour les onglets non-Épreuves, mais avec le composant unifié (plus `AdminAssistantGlobal`).
- `EpreuvesPanel.tsx` garde son état d'ouverture et monte le **même** composant en mode édition avec ses props existantes (`form`, `statut`, `conversationId`, `onAppliquer`, `onAnnuler`, `sujetActifRang`).
- `AdminAssistantGlobal.tsx` est supprimé une fois ses fonctionnalités (cartes de plan, approbation, ouverture de formulaire, surlignage des champs) reportées dans l'assistant unique.
- `adminContexte.ts` reste inchangé : le mode agent continue d'utiliser `publierContexteAdmin` / `lireContexteAdmin` / `ouvrirFormulaireAdmin` / `appliquerChampsAdmin`.
- Aucune modification backend prévue : le routeur choisit déjà la voie agent via `payload.agent` et la voie édition via `build_admin_prompt` quand l'onglet n'est pas dans `admin_tools.ONGLETS`.

## Tâches

### Phase 0 — Cadrage
- [x] Recenser les scénarios E2E existants qui vérifient les deux assistants (`frontend/e2e/e2e.mjs` : ~1567-1637, ~1687-1715, ~1717-1830, ~1831-1915, ~2890-2899) et noter ceux qui devront changer de sélecteur.
- [x] Établir la liste des sélecteurs conservés : dialogue `Tuteur IA Prep`, champ `Question à Tuteur IA Prep`, bascule `Appliquer automatiquement`, boutons `Tout approuver` / `Rejeter` / `Ignorer` / `Appliquer au sujet` / `Modifier` / `Valider` / `Réessayer`.

### Phase 1 — Assistant unique (interface)
- [x] Faire de `AdminAssistantPanel.tsx` le composant unique : garder son moteur de chat (MessageComposer, reconnexion, file, régénération, horodatage, auto-application).
- [x] Ajouter au modèle de message les champs nécessaires au mode agent : `plan`, `formulaires`, `editions`, `annulerEditions`.
- [x] Reporter depuis `AdminAssistantGlobal.tsx` le rendu des cartes de plan (libellés `LIBELLES_OUTILS`, arguments JSON, `Tout approuver`, `Rejeter`, `Ignorer`, `Éditer` → nouveau jeton via `/proposition`, `/commit`, états `attente/en-cours/fait/ignoree/erreur`).
- [x] Reporter les encarts « Formulaire ouvert » / « Champs remplis » avec bouton « Annuler ces modifications » (via `appliquerChampsAdmin`).
- [x] Dans le tiroir, afficher un bandeau de contexte : `ÉPREUVE EN COURS …` en mode édition, `ONGLET : <NOM>` en mode agent.
- [x] Gérer le changement d'onglet : la clé de conversation (`epreuve_id` ou `onglet:<nom>`) est recalculée et la discussion rechargée à chaque changement, sans mélanger les deux modes.

### Phase 2 — Adaptation du montage Épreuves
- [x] Arbitrer le montage : un composant unique, deux points de montage exclusifs (Épreuves / autres onglets), sans registre réactif (note ajoutée dans l'architecture cible).
- [x] Dans `EpreuvesPanel.tsx`, remplacer le composant par la version unifiée avec `onglet="epreuves"` et les props existantes ; conserver l'état d'ouverture, le lanceur et les callbacks d'application.
- [x] Vérifier qu'aucun import devenu inutile ne subsiste dans `EpreuvesPanel.tsx`.

### Phase 3 — Câblage unique
- [x] Dans `AdminPage.tsx`, monter l'assistant unique pour **tous** les onglets, avec `onglet={tab}`, `token`, et `onAction` (rafraîchissement du panneau + stats).
- [x] Dans l'assistant unique, construire la charge utile :
  - mode édition → `buildAdminAskPayload(form, historique, question, epreuveId, sujetActifRang)` + `onglet: "epreuves"`, `agent: false` ;
  - mode agent → `{ question, historique, epreuve: {}, onglet, agent: true, contexte: lireContexteAdmin(onglet) }`.
- [x] Appliquer les événements `formulaire`/`edition` exactement comme aujourd'hui (`ouvrirFormulaireAdmin` + `flushSync` + `appliquerChampsAdmin`), en conservant le bouton « Annuler ces modifications ».
- [x] Appliquer les modifications texte (`appliquerModifications`) en mode édition, automatiquement si la bascule est cochée, sinon via « Appliquer au sujet », avec « Annuler la dernière application ».
- [x] Supprimer `frontend/src/pages/admin/AdminAssistantGlobal.tsx` et nettoyer les imports/références.

### Phase 4 — Tests E2E
- [x] Remplacer l'assertion « pas de doublon d'assistant sur Épreuves » par « un seul assistant, quel que soit l'onglet ».
- [x] Mettre à jour les sélecteurs du mode agent (`Question à l'assistant` → `Question à Tuteur IA Prep`, lanceur `Assistant` → lanceur unique) sans affaiblir les assertions (plan, base, journal, action interdite).
- [x] Mettre à jour la vérification des deux lanceurs fixes (bureau/mobile) pour un lanceur unique.
- [x] Ajouter un scénario : ouverture de l'assistant sur Formules (plan), bascule vers Épreuves (édition de texte), retour vers Banque (champs remplis) — vérifier que seul le bon protocole est envoyé à chaque fois.
- [x] Vérifier que les scénarios de mémoire de conversation (onglet + brouillon attaché à l'épreuve) passent toujours.

### Phase 5 — Vérifications et livraison
- [x] `ruff check app tests` et suite backend complète (SQLite).
- [x] `npm test -- --run` et `npm run build`.
- [x] E2E complète (`e2e.mjs`) + recette Banque (`banque-e2e.mjs`) sur le build final.
- [x] `git diff --check`.
- [x] Test navigateur intégré : un seul bouton Assistant, tiroir Épreuves et tiroir Banque avec les bons contenus, aucun débordement à 1280 px.
- [x] Commit atomique, branche dédiée, PR, vérification CI au vert, fusion, synchronisation de `refonte`.

## Fichiers concernés

| Fichier | Action |
|---|---|
| `frontend/src/pages/admin/AdminAssistantPanel.tsx` | Devient l'assistant unique (chat + plan) |
| `frontend/src/pages/admin/AdminAssistantGlobal.tsx` | Supprimé |
| `frontend/src/pages/AdminPage.tsx` | Monte l'assistant unique sur tous les onglets |
| `frontend/src/pages/admin/EpreuvesPanel.tsx` | Retire son assistant, enregistre un adaptateur d'éditeur |
| `frontend/src/lib/adminContexte.ts` | Ajoute le registre d'éditeur |
| `frontend/src/lib/adminAssistant.ts` | Réutilisé pour le payload du mode édition |
| `frontend/e2e/e2e.mjs` | Sélecteurs + scénarios d'unification |

Backend : **aucune modification prévue** (`admin_assistant.py`, `admin_tools.py`, `admin_agent.py`, `admin_agent_struct.py` restent tels quels).

## Risques et mitigations

- **Perte du plan d'approbation en fusionnant** → reporter explicitement les cartes et le flux `/proposition` + `/commit` depuis `AdminAssistantGlobal` avant de le supprimer.
- **Perte de la reconnexion/file/régénération** → partir de `AdminAssistantPanel` comme base, pas de l'assistant global.
- **Mélange des conversations entre onglets** → clé de conversation recalculée et discussion rechargée à chaque changement d'onglet.
- **Formulaire Épreuves démonté** → il reste monté (div masquée) ; l'adaptateur enregistré fournit le snapshot frais.
- **Sélecteurs E2E** → mise à jour explicite, sans réduire les garanties testées (aucune écriture avant confirmation).

## Critères d'acceptation

1. Un seul lanceur « Assistant » et un seul tiroir sur toutes les pages du back-office.
2. Sur Épreuves : réponse, application manuelle/auto, annulation, édition d'une question, relance — identiques à aujourd'hui.
3. Sur les autres onglets : réponse contextuelle, ouverture/remplissage de formulaire, plan signé approuvable/modifiable/rejetable — identiques à aujourd'hui.
4. Aucune écriture serveur sans « Tout approuver » ; aucun champ modifié sans possibilité d'annulation.
5. Tous les tests (backend, frontend, build, E2E) au vert et PR fusionnée.
