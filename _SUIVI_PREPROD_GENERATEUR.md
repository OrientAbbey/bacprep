# Suivi préproduction — générateur d'épreuves

Mis à jour le **17 novembre 2026**. Ce fichier suit les corrections retenues après comparaison au cahier V4.10. Il complète `_PLAN_V410_GENERATEUR.md` sans le remplacer.

**Légende :** `[ ]` à faire · `[~]` en cours · `[x]` réalisé et vérifié.

> Ne cocher une tâche qu'après implémentation **et** vérification par les tests pertinents. Les fichiers locaux non suivis déjà présents dans le dépôt doivent être préservés.

## P0 — Intégrité et sécurité des données (bloquant avant mise en production)

- [x] **Protéger les options du référentiel utilisées par la banque (implémentation).** Compter les références dans les parties, métadonnées de classe et listes JSON des exercices ; refuser le renommage d'un code utilisé et la suppression d'une option encore référencée par la banque. Garder le libellé modifiable et préserver le comportement historique des épreuves hors banque.
  - Fichiers : `backend/app/routers/admin_referentiel.py`, `backend/tests/test_admin_referentiel.py`.
  - Tests admin_referentiel et banque_api verts.
- [ ] **Valider la protection d'intégrité** pour les scopes matière, classe et série : affichage correct de `en_usage`, renommage refusé (409), suppression refusée (409), libellé modifiable, suppression encore possible après réaffectation/suppression des références. Ajouter des cas avec plusieurs exercices et valeurs JSON.
- [x] **Imposer la spécialité obligatoire côté serveur et formulaire (implémentation).** Retourner `specialite_obligatoire` dans les options par classe ; exiger une spécialité lorsque la métadonnée de la classe le demande, même si l'appel contourne l'interface ; présenter le champ comme obligatoire et empêcher une génération sans sélection.
  - Fichiers : `backend/app/routers/banque.py`, `frontend/src/pages/EntrainementPage.tsx`, `frontend/src/api/types.ts`, `backend/tests/test_banque_api.py`.
  - Validation serveur ajoutée ; formulaire suit la règle ; typecheck frontend OK.
- [ ] **Tester la spécialité obligatoire** : classe avec obligation activée et requête sans spécialité refusée ; requête avec spécialité autorisée si l'accès le permet ; classe facultative conserve le comportement actuel ; sélection et changement de classe restent cohérents dans le formulaire.
- [x] **Séparer l'impression du sujet et du corrigé (implémentation).** Actions distinctes « Imprimer l'épreuve » et « Imprimer le corrigé » ; l'impression du sujet n'inclut jamais le corrigé, même s'il a été consulté à l'écran. Styles d'impression mis à jour.
  - Fichiers : `frontend/src/pages/EntrainementPage.tsx`, `frontend/src/index.css`, traductions dans `frontend/src/locales/en.json`.
- [ ] **Vérifier l'impression** avec corrigé masqué puis affiché, avec épreuve vide/incomplète et dans les deux langues (au minimum test de rendu/comportement disponible et recette navigateur).

## P1 — Expérience élève et décisions produit à valider avant ouverture

- [ ] **Formaliser la politique des messages élève (« silence total »).** Recommandation à valider : ne jamais exposer les événements techniques ni reprocher à l'élève une règle relâchée ou une banque insuffisante ; afficher un message bref et utile si zéro exercice est produit ; pour une génération partielle, rester neutre et ne pas révéler les diagnostics internes. Les erreurs d'accès, de connexion ou de chargement doivent rester compréhensibles et offrir une action de réessai adaptée.
  - Valider ce comportement produit, puis aligner l'API, `frontend/src/pages/EntrainementPage.tsx` et les tests. Références : réponse de `POST /api/banque/generer`, tests de silence et de gating.
- [ ] **Décider et documenter la rétention du journal technique**, distincte de la rétention des générations (365 jours, avec conservation de la génération la plus récente déjà retenue). Définir durée, traitement à la suppression de compte et accès admin, en tenant compte des élèves mineurs et des exigences applicables.
  - Fichiers à examiner : `backend/app/routers/banque.py`, `backend/app/routers/admin_banque.py`, `backend/app/db_models.py`.
- [ ] **Décider la portabilité des exports JSON.** Le format actuel est versionné et validé, mais son import exige que les options de matière, classe et spécialité existent déjà dans le référentiel partagé. Confirmer si l'usage visé est une sauvegarde/transfert entre environnements compatibles (limite à documenter) ou un fichier autonome et portable. Si le besoin autonome est confirmé, définir la gestion des options absentes et fournir/valider le schéma JSON demandé avant d'étendre le comportement.
  - Fichiers à examiner : `backend/app/routers/admin_banque.py`, `backend/schemas/`, tests d'import/export.
- [ ] **Valider la stratégie de tirage des parties.** Le code garantit des parties distinctes quand c'est possible, mais ne garantit pas explicitement un tirage uniforme des parties comme le décrit le cahier. Vérifier par les règles/tests actuels si cette divergence est acceptable ; documenter l'arbitrage produit/pédagogique et ne modifier l'algorithme qu'après validation.
- [ ] **Valider que la banque est suffisamment alimentée avant ouverture** et que les classes/matières proposées correspondent aux contenus réellement disponibles ; prévoir une recette de génération complète, partielle et sans résultat.

## P2 — Recette préproduction et clôture

- [ ] Exécuter les tests backend ciblés puis la suite backend complète ; corriger les régressions.
- [x] Exécuter `npm test` et `npm run build` dans `frontend/` ; 298 tests verts et build OK.
- [ ] Faire une recette intégrée : admin configure/import une banque, élève authentifié génère, consulte le sujet et le corrigé, imprime séparément ; vérifier aussi le refus d'accès hors abonnement et la propriété des générations.
- [ ] Relire les changements et vérifier `git status` : ne modifier ni supprimer les fichiers locaux non suivis sans accord explicite.
- [ ] Mettre à jour ce suivi et `_PLAN_V410_GENERATEUR.md` si une décision produit ou un écart au cahier est retenu ; ne cocher que les points réellement vérifiés.

## Arbitrages et recommandations déjà notés

- **Approche générale :** ne pas viser une conformité littérale au cahier V4.10 ; valider une version adaptée au projet. Le cœur du générateur fonctionne : pas de réécriture globale.
- Garder le référentiel réel du projet, les trois séquences actuelles et le rang des classes dérivé de l'ordre du référentiel — ne pas changer ces choix uniquement pour copier le cahier.
- Garder la rétention des générations à 365 jours et la conservation de la plus récente par élève. La durée de conservation du journal technique reste à décider séparément.
- Ordre prioritaire : protéger les références du référentiel, appliquer l'obligation de spécialité côté serveur et formulaire, puis séparer l'impression du sujet et du corrigé.
- Le silence technique reste à préserver, mais la recommandation produit est un message bref lorsque zéro exercice est généré ; cette politique doit encore être validée.
- La portabilité autonome de l'import/export n'est pas présumée : d'abord confirmer le besoin, puis définir l'extension si nécessaire.
- La divergence sur l'uniformité du tirage des parties doit être évaluée et documentée avant tout changement d'algorithme.

## Fichiers de référence

- `_PLAN_V410_GENERATEUR.md` — analyse et écarts du générateur au cahier V4.10.
- `backend/app/routers/admin_referentiel.py` — administration du référentiel partagé.
- `backend/app/routers/banque.py` — options et API élève du générateur.
- `backend/app/routers/admin_banque.py` — administration, journal et import/export.
- `frontend/src/pages/EntrainementPage.tsx` — formulaire, résultat et impression.
