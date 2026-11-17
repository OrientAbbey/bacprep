# Suivi préproduction — générateur d'épreuves

Mis à jour le **17 novembre 2026**. Ce fichier suit les corrections retenues après comparaison au cahier V4.10. Il complète `_PLAN_V410_GENERATEUR.md` sans le remplacer.

**Légende :** `[ ]` à faire · `[~]` en cours · `[x]` réalisé et vérifié.

> Ne cocher une tâche qu'après implémentation **et** vérification par les tests pertinents. Les fichiers locaux non suivis déjà présents dans le dépôt doivent être préservés.

## P0 — Intégrité et sécurité des données (bloquant avant mise en production)

- [x] **Protéger les options du référentiel utilisées par la banque (implémentation).** Compter les références dans les parties, métadonnées de classe et listes JSON des exercices ; refuser le renommage d'un code utilisé et la suppression d'une option encore référencée par la banque. Garder le libellé modifiable et préserver le comportement historique des épreuves hors banque.
  - Fichiers : `backend/app/routers/admin_referentiel.py`, `backend/tests/test_admin_referentiel.py`.
  - Tests admin_referentiel et banque_api verts.
- [x] **Valider la protection d'intégrité** pour les scopes matière, classe et série : affichage correct de `en_usage`, renommage refusé (409), suppression refusée (409), libellé modifiable, suppression encore possible après réaffectation/suppression des références. Tests ajoutés pour les trois scopes.
- [x] **Imposer la spécialité obligatoire côté serveur et formulaire (implémentation).** Retourner `specialite_obligatoire` dans les options par classe ; exiger une spécialité lorsque la métadonnée de la classe le demande, même si l'appel contourne l'interface ; présenter le champ comme obligatoire et empêcher une génération sans sélection.
  - Fichiers : `backend/app/routers/banque.py`, `frontend/src/pages/EntrainementPage.tsx`, `frontend/src/api/types.ts`, `backend/tests/test_banque_api.py`.
  - Validation serveur ajoutée ; formulaire suit la règle ; typecheck frontend OK.
- [x] **Tester la spécialité obligatoire** : classe avec obligation activée et requête sans spécialité refusée (422) ; requête avec spécialité acceptée ; classe facultative conserve l'absence de spécialité. Tests API ajoutés.
- [x] **Séparer l'impression du sujet et du corrigé (implémentation).** Actions distinctes « Imprimer l'épreuve » et « Imprimer le corrigé » ; l'impression du sujet n'inclut jamais le corrigé, même s'il a été consulté à l'écran. Styles d'impression mis à jour.
  - Fichiers : `frontend/src/pages/EntrainementPage.tsx`, `frontend/src/index.css`, traductions dans `frontend/src/locales/en.json`.
- [x] **Vérifier l'impression** avec corrigé masqué puis affiché, avec épreuve vide/incomplète et dans les deux langues — recette navigateur (`frontend/e2e/banque-e2e.mjs`) : impression sujet et corrigé vérifiées via l'émulation `print` (seule la zone active visible, `#root` masqué, pas de fuite du corrigé dans le sujet).

## P1 — Expérience élève et décisions produit à valider avant ouverture

- [x] **Politique des messages élève (« silence total ») — décision.** Les événements techniques restent dans le journal admin et ne sont jamais renvoyés à l'élève (tests de silence existants). Zéro exercice → message bref et neutre déjà présent (« Aucun exercice n'a pu être préparé… ») avec action de régénération. Génération partielle → rendu neutre, sans diagnostic. Erreurs d'accès/connexion/chargement → message compréhensible + bouton « Réessayer ». Conforme aux bonnes pratiques UX (NN/g, Mobbin) : pas de jargon technique, pas de reproche à l'élève, action proposée.
- [x] **Rétention du journal technique — décision et implémentation.** Conservation bornée à **365 jours par défaut**, configurable via `BANQUE_JOURNAL_RETENTION_JOURS` (valeur ≤ 0 = illimitée, à assumer par l'administration). Purge effectuée lors de la purge d'historique, avec trace `INFO_JOURNAL_PURGED` sous identifiant système. Le journal reste lisible après suppression de compte (audit technique) mais n'est plus conservé sans limite. Justification : principe de limitation du stockage (RGPD art. 5.1.e ; loi camerounaise n° 2024/017, art. 28) et protection renforcée des mineurs.
  - Fichiers : `backend/app/routers/banque.py`, `backend/tests/test_banque_api.py`.
- [x] **Portabilité des exports JSON — décision et schéma.** Usage retenu : **sauvegarde/transfert entre environnements compatibles**, pas fichier autonome. L'import exige que les options de matière/classe/spécialité existent déjà dans le référentiel cible (limite documentée). Schéma versionné fourni : `backend/schemas/banque-1.0.schema.json` (JSON Schema draft-07), test de cohérence avec l'export. Si un besoin autonome est confirmé, étendre l'import pour créer les options manquantes dans un second temps.
  - Fichiers : `backend/schemas/banque-1.0.schema.json`, `backend/tests/test_admin_banque.py`.
- [x] **Stratégie de tirage des parties — arbitrage.** Le code garantit des parties distinctes quand c'est possible (règle 4.a et exceptions), sans tirage uniforme explicite. **Aucun changement d'algorithme** : la divergence au cahier est acceptable car la règle pédagogique principale (pas deux exercices de la même partie sauf exceptions) est respectée et couverte par les tests purs. Documentée comme écart volontaire.
- [ ] **Valider que la banque est suffisamment alimentée avant ouverture** et que les classes/matières proposées correspondent aux contenus réellement disponibles ; prévoir une recette de génération complète, partielle et sans résultat.

## P2 — Recette préproduction et clôture

- [x] Exécuter les tests backend ciblés puis la suite backend complète : 849 passed, 2 skipped, aucune régression.
- [x] Exécuter `npm test` et `npm run build` dans `frontend/` ; 298 tests verts et build OK.
- [x] Faire une recette intégrée : admin configure/import une banque, élève authentifié génère, consulte le sujet et le corrigé, imprime séparément ; vérifier aussi le refus d'accès hors abonnement et la propriété des générations.
  - `frontend/e2e/banque-e2e.mjs` : **9/9 scénarios verts** (options, gating 403, propriété 404, formulaire, spécialité obligatoire, impression sujet/corrigé, réaffichage après rechargement).
  - Correctif issu de la recette : l'épreuve composée se recharge désormais via `?gen=<id>` (avant, un rechargement perdait l'épreuve affichée).
- [ ] Relire les changements et vérifier `git status` : ne modifier ni supprimer les fichiers locaux non suivis sans accord explicite.
- [ ] Mettre à jour ce suivi et `_PLAN_V410_GENERATEUR.md` si une décision produit ou un écart au cahier est retenu ; ne cocher que les points réellement vérifiés.

## Arbitrages et recommandations déjà notés

- **Approche générale :** ne pas viser une conformité littérale au cahier V4.10 ; valider une version adaptée au projet. Le cœur du générateur fonctionne : pas de réécriture globale.
- Garder le référentiel réel du projet, les trois séquences actuelles et le rang des classes dérivé de l'ordre du référentiel — ne pas changer ces choix uniquement pour copier le cahier.
- Rétention des générations : **365 jours**, conservation de la plus récente par élève. Rétention du journal technique : **365 jours par défaut**, configurable (`BANQUE_JOURNAL_RETENTION_JOURS`), 0 = illimité.
- Ordre prioritaire : protéger les références du référentiel, appliquer l'obligation de spécialité côté serveur et formulaire, puis séparer l'impression du sujet et du corrigé. **Fait.**
- Silence technique préservé ; message bref et neutre si zéro exercice ; erreurs avec réessai. **Décidé.**
- Import/export : sauvegarde/transfert entre environnements compatibles ; schéma `banque-1.0.schema.json` fourni ; portabilité autonome non présumée. **Décidé.**
- Tirage des parties : divergence au cahier acceptée et documentée, sans modification d'algorithme. **Décidé.**

## Recherche et sources (confiance)

- **Limitation du stockage (mineurs) :** RGPD art. 5(1)(e) ; ICO « storage limitation » ; CNIL « durées de conservation » ; IAPP « kids and teens privacy » ; loi camerounaise n° 2024/017 du 23 décembre 2014 (art. 28, durées maximales à préciser par l'Autorité).
- **État vide / messages élève :** NN/g « Designing Empty States » ; Mobbin « Empty State » ; Moodle « Empty states » ; LogRocket « UX error messages » ; NN/g « Error Message Guidelines » (pas de jargon, action proposée, pas de reproche).
- **Impression séparée :** MDN « Printing » ; CSS-Tricks « Print Stylesheet Approaches » ; SitePoint « Printer-friendly pages ».
- **Schéma JSON versionné :** json-schema.org (draft-07) ; Zuplo « JSON Schema Validation » ; DatoCMS/UiPath sur l'export/import de schémas.

## Fichiers de référence

- `_PLAN_V410_GENERATEUR.md` — analyse et écarts du générateur au cahier V4.10.
- `backend/app/routers/admin_referentiel.py` — administration du référentiel partagé.
- `backend/app/routers/banque.py` — options, génération, rétention des générations et du journal.
- `backend/app/routers/admin_banque.py` — administration, journal et import/export.
- `backend/schemas/banque-1.0.schema.json` — schéma du snapshot de banque.
- `frontend/src/pages/EntrainementPage.tsx` — formulaire, résultat et impression.
