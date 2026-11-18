# PLAN — AGENT ADMIN TRANSVERSE (avec approbation avant sauvegarde)

> Fichier de suivi de progression. Cocher les cases au fur et à mesure et renseigner le §8.
>
> Statut : **PLAN validé — en attente d'exécution**. Date : 18 novembre 2026.
> Branche de départ : `feature/rendu-latex-editeur` (PR ouverte **#4**).
> Décisions : voir §1. Périmètre : **les 12 onglets d'administration**, assistant Épreuves conservé.

---

## 0. ÉTAT INITIAL (à ne pas perdre de vue)

- Branche courante : `feature/rendu-latex-editeur` ; remote `origin` = `https://github.com/OrientAbbey/bacprep.git`.
- **PR #4 ouverte** : « feat: rendu LaTeX/KaTeX et éditeur unifiés (maths, physique, chimie, SMILES) ».
- Arbre de travail non commité au départ (à inclure dans la PR finale, voir §6) :
  - correctifs référentiels triés + séquences Banque/validation dynamiques ;
  - aide Banque réécrite + contexte des formulaires transmis à l'assistant ;
  - `frontend/src/lib/adminContexte.ts` (nouveau, non suivi) ;
  - serveur local lancé sur `http://127.0.0.1:8000` (à redémarrer après modification).
- **Ne PAS inclure** dans la PR : `tmp_*.txt`, `tmp_*.py`, `*_REVUE_TMP_*`, `*_REVUE_VERSIONS_*`, `_CRITIQUE_SPECS_V1.md`, `_CHECKLIST_JURIDIQUE_D10.md`, `_SPEC_MATRICULE_AK.md`, `brouillon architecture technique.txt` (documents préexistants non suivis).
- Ce plan lui-même : décider en §6 s'il est commité avec la PR ou laissé hors suivi (comme `_PLAN_V410_GENERATEUR.md`).

---

## 1. DÉCISIONS RETENUES (validées par l'utilisateur)

| # | Décision | Raison |
|---|---|---|
| D1 | Séparer **espace de travail libre** (lecture + édition du formulaire) et **point de commit approuvé** (toute écriture serveur) | « comme l'admin » sans friction, mais garder un contrôle réel |
| D2 | **Un plan groupé approuvé une fois** par lot, pas une permission par action | ~93 % d'approbations machinales (Anthropic) → déplacer le contrôle vers la stratégie |
| D3 | Suppressions, restauration de sauvegarde, changements de rôle **restent hors liste blanche** | politique de sécurité actuelle de `admin_tools.py` |
| D4 | Publication (visible par les élèves) **autorisée avec approbation** | cohérent avec D1/D2 |
| D5 | Pas de *trust once* pour l'instant ; réévalué après le pilote | éviter l'approbation automatique |
| D6 | Garder le **protocole JSON fencé maison** (pas de function-calling natif) | indépendant du fournisseur, déjà en place |
| D7 | Pas d'automatisation de navigateur (Playwright) | fragile et dangereux |
| D8 | L'agent agit **sous la session admin existante**, jamais avec ses propres identifiants | pas d'élévation de privilèges |

---

## 2. ARCHITECTURE CIBLE

### 2.1 Les deux espaces

1. **Espace de travail (aucune permission)** — l'agent lit les résumés/contextes et modifie directement les champs du formulaire affiché. L'admin voit les changements en direct, avec *Annuler*. Généralisation du mécanisme déjà utilisé par l'assistant Épreuves.
2. **Point de commit (une permission pour tout le lot)** — toute écriture serveur (enregistrer, publier, bannir, créer…) est regroupée dans un plan avec aperçu/avant-après. Une seule approbation déclenche l'exécution.

> Un « plan » peut contenir plusieurs actions ; elles sont validées ensemble et exécutées dans l'ordre.

### 2.2 Niveaux de risque des outils

| Niveau | Comportement | Exemples |
|---|---|---|
| `lecture` | exécution immédiate, jamais de permission | résumés d'onglet, détail épreuve/banque, aperçu gabarit |
| `brouillon` | appliqué au formulaire côté client, annulable, **aucune écriture serveur** | `edition-champ`, `remplacer-sujet`, `modification-form` |
| `commit` | regroupé dans le plan, approbation obligatoire | création/modification, publication, ban/déban, résolution, import, export |

**Hors liste blanche (D3)** : suppression (épreuve, utilisateur, plan, notification, option, sauvegarde, fichier, partie/exercice banque), restauration, promouvoir/démouvoir.

### 2.3 Chaîne d'approbation (point de sécurité clé)

1. L'agent produit un plan = `[{outil, args}, …]`.
2. Le serveur crée un **jeton opaque signé HMAC** lié à `{admin, outils+args normalisés, expiration ~5 min, nonce}`.
3. Le client affiche le plan (libellés, avant/après) et demande une seule approbation.
4. Le client renvoie **le jeton**, pas les arguments modifiables.
5. Le serveur revérifie : session `require_admin`, liste blanche, schémas, jeton valide et non rejoué → exécute via les handlers existants → journalise.
6. Échec de toute vérification → **fail closed** (rien n'est exécuté).

### 2.4 Boucle d'agent (manquante aujourd'hui)

`observer → planifier → agir → observer le résultat → recommencer`, **bornée** (6 itérations max). Les résultats des lectures sont réinjectés au modèle. Événements SSE : `etape`, `edition`, `proposition`, `resultat`, `erreur`.

---

## 3. PHASES DE TRAVAIL

### P0 — Fondations sécurisées

- [ ] **P0.1** Ajouter un champ `risque` (`lecture` | `brouillon` | `commit`) à `Outil` dans `backend/app/core/admin_tools.py` ; annoter les 11 outils existants (`commit` pour tous les actuels).
- [ ] **P0.2** Étendre la liste blanche aux opérations `commit` manquantes, **sans suppression ni rôle ni restauration** : banque CRUD, gabarit validation/résolution, option modifier/supprimer ?, plan supprimer ?, notification modifier/toggle, événement modifier, épreuve créer/modifier, import (dry-run), sauvegarde export. *Décider article par article ; inscrire chaque choix dans le §8.*
- [ ] **P0.3** Créer `backend/app/core/admin_approbation.py` : création/vérification du jeton HMAC (secret serveside), expiration, nonce anti-rejeu, normalisation des arguments.
- [ ] **P0.4** Créer `POST /api/admin/assistant/commit` dans `backend/app/routers/admin_assistant.py` : valide le jeton, revérifie chaque action, exécute via `admin_tools.executer`, journalise `assistant_commit` + un `assistant_action` par outil, commit. Schéma `CommitIn` borné (max 10 actions).
- [ ] **P0.5** Tests : jeton falsifié/expiré/rejoué refusé, action hors liste blanche refusée, champs en trop refusés, audit écrit, échec partiel tracé.
- [ ] **P0.6** `git diff --check` + tests backend ciblés verts.

**Acceptation P0** : aucune écriture possible sans jeton valide ; les 11 outils existants passent encore leurs tests.

### P1 — Boucle d'agent bornée

- [ ] **P1.1** Créer `backend/app/core/admin_agent.py` : fonction `executer_agent(question, resume, contexte, historique, outils)` implémentant la boucle bornée (6 itérations), avec réinjection des résultats de lecture dans le prompt.
- [ ] **P1.2** Protocole de sortie : un bloc fencé par intention (````lecture`, ````edition`, ````plan`), JSON strict validé par schéma ; inconnu → ignoré + message au modèle.
- [ ] **P1.3** Émettre les événements SSE `etape`/`edition`/`proposition`/`resultat` depuis `/ask` (sans casser les événements `chunk`/`done`/`error` existants).
- [ ] **P1.4** Limites : max 6 itérations, max 12 outils/tour, max 10 actions/plan, garde-fou anti-boucle sur intention identique répétée.
- [ ] **P1.5** Tests unitaires de la boucle avec LLM mocké (lecture réinjectée, arrêt à la limite, plan produit).

**Acceptation P1** : une demande en plusieurs étapes produit un plan final, sans permission intermédiaire, et la trace des étapes est visible.

### P2 — Généralisation du contexte et des éditions de formulaire

- [ ] **P2.1** Étendre `frontend/src/lib/adminContexte.ts` : ajouter un **schéma de champs** `{cle, libelle, type, options?}` par panneau, en plus des valeurs.
- [ ] **P2.2** Publier ce contexte dans **tous les panneaux** (`FormulesPanel`, `CalendrierPanel`, `NotificationsPanel`, `ParametresPanel`, `UtilisateursPanel`, `SignalementsPanel`, `BanquePanel` déjà fait, `GabaritsPanel`, `ImportPanel`, `SauvegardesPanel`, `JournalPanel`). Nettoyage au démontage.
- [ ] **P2.3** Créer `frontend/src/lib/adminEditions.ts` : parseur module-agnostique des blocs `edition-champ`, réutilisant la logique de `adminAssistant.ts` (remplacements exacts, diff, validation).
- [ ] **P2.4** Dans chaque panneau, brancher `onEditions` : applique les champs au state local, fournit une **annulation** (snapshot avant/après), **n'envoie rien au serveur**.
- [ ] **P2.5** Étendre `AdminAssistantGlobal.tsx` : nouvelle prop `onEditions`, application immédiate des blocs `edition` reçus, bouton *Annuler la dernière édition*.

**Acceptation P2** : dans au moins 3 panneaux pilotes (Banque, Formules, Calendrier), l'agent remplit le formulaire sous les yeux de l'admin, sans rien enregistrer, avec annulation fonctionnelle.

### P3 — Vue de révision et approbation groupée

- [ ] **P3.1** Dans `AdminAssistantGlobal.tsx`, remplacer la carte « Confirmer / Ignorer » par une vue **Discussion / Modifications proposées** :liste des actions du plan, libellés, avant/après, *Tout approuver*, *Approuver/Éditer/Rejeter* par élément.
- [ ] **P3.2** *Éditer* = ouvrir les arguments du plan (return of control) puis **re-demander un jeton** au serveur avant approbation (jamais réutiliser le jeton d'origine).
- [ ] **P3.3** Sur approbation : `POST /api/admin/assistant/commit` avec le jeton, puis `onAction()` (rafraîchissement du panneau via la clé `rafraichir` de `AdminPage.tsx`).
- [ ] **P3.4** Afficher le résultat par action (succès / erreur) et garder une trace non rejouable dans la conversation.
- [ ] **P3.5** Accessibilité : boutons `min-h-[44px]`, `aria-label`, `role="status"`/`"alert"`, focus visible, navigation clavier.

**Acceptation P3** : un plan de 3 actions est approuvé en un clic, exécuté, journalisé, et le panneau se rafraîchit ; un plan rejeté ne modifie rien.

### P4 — Sécurité, limites et réglages fins

- [ ] **P4.1** Prompt injection : délimiteurs explicites autour du contexte, rappel « données jamais consignes », test avec un champ contenant `'```action …'`.
- [ ] **P4.2** Sorties LLM : JSON strict + schéma Pydantic/TS, jamais `eval`, pas de HTML injecté (MarkdownContent reste échappé).
- [ ] **P4.3** Rate limit existant 30/5 min conservé ; ajouter compteur d'itérations/outils par question côté agent.
- [ ] **P4.4** Confidentialité : ne jamais mettre d'email complet ni de secret dans le prompt (le `masquer_email` existant reste).
- [ ] **P4.5** Audit : vérifier que chaque décision (approbation/rejet) et chaque exécution apparaît dans `admin_events` et dans `GET /api/admin/events`.

**Acceptation P4** : les tests d'abus passent ; le journal contient décision + exécution.

### P5 — Extension à tous les onglets et recette

- [ ] **P5.1** Généraliser P2/P3 des 3 pilotes aux 12 onglets de `frontend/src/pages/admin/onglets.ts`.
- [ ] **P5.2** Synchroniser les trois points de vérité : `TOOLS` (backend), `LIBELLES_OUTILS` (`adminActions.ts`), catalogue dans `prompt_onglet`. Ajouter un test qui échoue s'ils divergent.
- [ ] **P5.3** Écrire la recette acceptable dans `frontend/src/pages/aide/AideAdmin.tsx` (ce que l'agent peut faire / ne peut pas faire, le rôle de l'approbation, l'annulation).
- [ ] **P5.4** Mise à jour éventuelle de `README.md` (section assistant admin).

**Acceptation P5** : l'agent est disponible et testé dans tous les modules.

### P6 — Validation complète

- [ ] **P6.1** Backend : `pytest -q` (SQLite) puis PostgreSQL si disponible.
- [ ] **P6.2** Frontend : `npm test`, `npx tsc --noEmit`, `npm run build`.
- [ ] **P6.3** Test navigateur (si serveur dispo) : pilote Banque/Formules/Calendrier, approbation, annulation, journal.
- [ ] **P6.4** `git diff --check` sans erreur de contenu.
- [ ] **P6.5** Redémarrer le serveur (`uvicorn app.main:app --port 8000`) pour refléter le build.

### P7 — PR, PR ouvertes au vert, fusion (**à faire en tout dernier**)

- [ ] **P7.1** Faire le point : `git status --short`, `git diff --stat`, lister les fichiers à inclure **et à exclure** (§0).
- [ ] **P7.2** Commits atomiques, dans cet ordre :
  1. `fix(admin): trier les référentiels et séquences Banque dynamiques`
  2. `fix(admin): aide Banque et contexte de formulaire transmis à l'assistant`
  3. `feat(admin): fondations agent — niveaux de risque et jeton d'approbation`
  4. `feat(admin): boucle d'agent bornée et événements SSE`
  5. `feat(admin): éditions de formulaire généralisées et vue de révision`
  6. `test(admin): couverture agent, approbation et garde-fous`
  7. `docs(admin): aide et plan de l'agent transverse` *(si le plan est commité)*
- [ ] **P7.3** Vérifier les secrets : `git diff --cached | grep -i "password\|secret\|api_key\|token"` (le mot `token` apparaîtra légitimement pour le jeton d'approbation — vérifier manuellement qu'aucune clé réelle n'est incluse).
- [ ] **P7.4** Pousser la branche : `git push -u origin feature/rendu-latex-editeur`.
- [ ] **P7.5** Regrouper **toutes** les modifications dans **une seule PR** : la PR #4 existante est le bon contenant (même branche). Vérifier `gh pr view 4` — titre/description mis à jour pour couvrir l'agent ET les correctifs.
- [ ] **P7.6** Lister **toutes** les PR ouvertes : `gh pr list --state open`. Pour chacune : `gh pr checks <numéro> --watch --fail-fast` (CI, tests, build, revue). Corriger toute échec avant fusion.
- [ ] **P7.7** Confirmer que **toutes les PR ouvertes sont au vert** : `gh pr list --state open --json number,statusCheckRollup` puis vérification manuelle du résultat.
- [ ] **P7.8** Fusionner dans l'ordre (dépendances d'abord) : `gh pr merge <numéro> --squash` (ou `--merge` selon la convention du dépôt). Attendre la fin de chaque fusion avant la suivante.
- [ ] **P7.9** Vérifier après fusion : `git fetch && git status`, la branche principale contient bien tout, aucune PR ouverte résiduelle.
- [ ] **P7.10** Noter dans le §8 les numéros de PR fusionnés et l'état final.

---

## 4. CHECKLIST SÉCURITÉ (à recocher à la fin)

- [ ] Décision (modèle) séparée de l'exécution (couche politique qui revérifie tout).
- [ ] Approbation liée à l'action exacte : acteur, outils, args normalisés, expiration, nonce.
- [ ] Jeton non réutilisable après édition du plan (nouveau jeton).
- [ ] Liste blanche : aucune suppression, restauration ou changement de rôle.
- [ ] Sorties LLM traitées comme données (JSON strict, pas de `eval`, pas de HTML brut).
- [ ] Contexte de formulaire traité comme données, jamais comme consignes.
- [ ] Limites : itérations, outils/tour, actions/plan, taille du contexte, rate limit.
- [ ] Fail closed sur toute erreur de validation/policy/audit.
- [ ] Audit complet : décision + exécution dans `admin_events`.
- [ ] Aucun secret ni email complet dans les prompts.

---

## 5. FICHIERS SUSCEPTIBLES D'ÊTRE TOUCHÉS

**Backend** : `core/admin_tools.py`, `core/admin_assistant.py`, `core/admin_approbation.py` (nouveau), `core/admin_agent.py` (nouveau), `routers/admin_assistant.py`, `tests/test_admin_assistant*.py`, `tests/test_admin_approbation.py` (nouveau).

**Frontend** : `lib/adminContexte.ts`, `lib/adminEditions.ts` (nouveau), `lib/adminActions.ts`, `pages/admin/AdminAssistantGlobal.tsx`, `pages/admin/AdminPage.tsx`, les panneaux de `pages/admin/`, `pages/aide/AideAdmin.tsx`, tests associés.

---

## 6. DÉCISIONS PRISES EN COURS DE ROUTE

| Date | Sujet | Décision | Raison |
|---|---|---|---|
| 2026-11-18 | Suppressions / rôles / restauration | hors liste blanche | D3 |
| 2026-11-18 | Publication | autorisée avec approbation | D4 |
| 2026-11-18 | Protocole | JSON fencé maison | D6 |
| 2026-11-18 | PR finale | une seule PR (#4 existante) regroupant tout | demande utilisateur |
| 2026-11-18 | Voie agent dans `/ask` | flag `agent` (défaut faux) | conserve le comportement historique et ses tests |
| 2026-11-18 | Resignature d'un plan édité | endpoint `/proposition` | return of control sans réutiliser le jeton d'origine |
| 2026-11-18 | Secret HMAC | `ADMIN_APPROBATION_SECRET` documenté dans `.env.example` | obligatoire en multi-instance |
| 2026-11-18 | P0.2 article par article | 22 outils `commit` ; exclus : toutes suppressions, restauration, rôles, import/export banque, import massif | D3 + périmètre raisonnable |

*(à compléter au fil des phases, notamment le choix article par article de P0.2)*

---

## 7. SUIVI DE PROGRESSION

| Phase | Statut | Date début | Date fin | Note |
|---|---|---|---|---|
| P0 — Fondations sécurisées | ✅ Terminé | 18/11 | 18/11 | 22 outils `commit`, jeton HMAC, `/commit`, `/proposition` |
| P1 — Boucle d'agent | ✅ Terminé | 18/11 | 18/11 | 6 itérations max, réinjection des lectures, SSE `edition`/`proposition` |
| P2 — Contexte/éditions | ✅ Terminé | 18/11 | 18/11 | registre d'appliqueurs, 5 panneaux formels câblés |
| P3 — Révision/approbation | ✅ Terminé | 18/11 | 18/11 | vue plan, approbation groupée, édition → nouveau jeton |
| P4 — Sécurité | ✅ Terminé | 18/11 | 18/11 | injection traitée comme donnée, sync TOOLS ↔ libellés, audit |
| P5 — Tous les onglets | ✅ Terminé | 18/11 | 18/11 | assistant disponible partout ; aide admin mise à jour |
| P6 — Validation | ✅ Terminé | 18/11 | 18/11 | backend **984 passed, 1 skipped** ; frontend **309 passed** ; tsc + build OK ; serveur redémarré, `/api/health` vert |
| P7 — PR / vert / fusion | ▶ En cours | 18/11 | | PR #4 ouverte au départ |

Légende : ☐ À faire · ▶ En cours · ✅ Terminé · ⚠ Bloqué.

---

## 8. JOURNAL D'EXÉCUTION

*(À alimenter : ce qui a été fait, les problèmes rencontrés, les corrections apportées, les PR fusionnées.)*

- **2026-11-18** — Plan écrit et validé. État initial : branche `feature/rendu-latex-editeur`, PR #4 ouverte, arbre de travail contenant les correctifs référentiels/Banque/assistant. Serveur local actif sur le port 8000.
- **2026-11-18** — P0–P5 implémentés : `admin_approbation.py` (HMAC + anti-rejeu), `admin_agent.py` (boucle bornée), 22 outils `commit`, endpoints `/proposition` et `/commit`, registre d'appliqueurs admin, vue plan dans le tiroir, aide admin mise à jour. Limite assumée : seuls les panneaux à formulaire (Banque, Formules, Calendrier, Notifications, Paramètres) publient le contexte détaillé ; les autres modules reposent sur le résumé serveur, l'assistant y étant bien disponible.
- **2026-11-18** — Premier passage des 985 tests backend : 982 OK, 2 échecs (1 d'environnement : `psycopg` absent ; 1 réel : variable `ADMIN_APPROBATION_SECRET` absente de `.env.example`). Corrections apportées : `psycopg[binary]` installé dans le venv local, variable documentée. Second passage : **984 passed, 1 skipped**. Frontend : **309 passed**, tsc + build OK. Serveur redémarré sur le port 8000, `/api/health` vert.
- **2026-11-18** — Phase P7 lancée : commits atomiques puis vérification/fusion des PR.
