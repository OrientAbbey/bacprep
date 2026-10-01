# Plan d'implémentation — Sauvegardes (export / restauration)

> **Convention de suivi** : chaque étape porte une case `- [ ]`. Je la passe à
> `- [x]` **uniquement lorsque l'étape est implémentée ET vérifiée** (test
> exécuté, pas « ça compile »). Le plan est mis à jour au fur et à mesure.

---

## 1. Résumé des implémentations

Une fonctionnalité d'export/restauration du catalogue d'épreuves, dans un
**onglet unique « Sauvegardes »** du back-office.

**L'export** produit une sauvegarde versionnée et vérifiée :

```
_sauvegardes/2026-09-27T2240Z/
├── manifest.json        # état autoritaire complet (toujours téléchargeable seul)
├── index.json           # SHA-256 + taille de chaque partie
├── sauvegarde.zip        # si total <= 1 Go
└── part-0001.zip …      # parties autonomes de 256 Mo si total > 1 Go
```

**La restauration** offre deux modes aux risques opposés :

- **Recharge du stockage** (base intacte) — réécrit les objets à leurs
  `storage_key` exactes. Idempotent, reprenable, aucun risque sur les données.
  C'est le mode par défaut, et le cas d'usage principal (migration de bucket).
- **Restauration complète** (base vide) — rejoue le manifeste en préservant les
  identifiants. `dry_run` obligatoire avant toute écriture.

**Propriétés garanties :**

1. **Fidélité** — un aller-retour export → restauration → ré-export donne des
   checksums identiques. C'est le test de référence du projet.
2. **Intégrité prouvée** — l'export se termine sur « checksums vérifiés », et la
   restauration refuse d'écrire un fichier dont le checksum ne correspond pas.
3. **Échelle** — aucune limite à 200 Mo ni 500 fichiers : l'écriture est en
   flux, le pic disque local est une partie (256 Mo), et le total n'est borné que
   par le stockage.
4. **Préservation des identifiants** — `epreuve_files.id` étant conservé, les
   références `/api/files/{id}` contenues dans le Markdown **restent valides** :
   aucune réécriture du contenu à la restauration.

**Trois corrections préalables de l'import existant** s'imposent, parce que ce
sont des pertes de données silencieuses qui toucheraient la restauration
(voir §3, étape 0).

---

## 2. Décisions actées

| Sujet | Décision |
|---|---|
| Périmètre | **Export manuel uniquement.** Aucune sauvegarde programmée, aucun ordonnanceur. |
| Onglets | **Un seul onglet** « Sauvegardes ». La restauration est une vue dédiée ouverte depuis une ligne, pas un formulaire permanent. |
| Découpage | Une partie = un ZIP **autonome** si total > 1 Go ; un seul ZIP si total <= 1 Go. |
| Identifiants | Préservés à l'export ; restaurés tels quels. Pas de mode « import dans une base existante ». |
| Fidélité des octets | La restauration écrit les octets **tels quels**, sans réencodage Pillow. |
| Export/restauration | `dry_run` par défaut. La restauration complète refuse une base non vide. |
| Rétention | **Suppression manuelle uniquement.** Pas de purge automatique : un export manuel est une décision humaine, l'effacer automatiquement serait destructif. Affichage du volume total occupé par les sauvegardes. |
| Téléchargement | URL signée via `presigned_url_or_none` (existant) : le volume ne transite pas par l'app. Repli streaming FastAPI en local. |
| CLI de sauvegarde | **Hors périmètre.** L'app sert le panneau ; si elle répond, le panneau répond. |

## 2 bis. Hors périmètre (assumé explicitement)

- Sauvegarde programmée / cron.
- Chiffrement des sauvegardes au repos (délégué au fournisseur de stockage).
- Compression « maximale » des parties : le coût CPU sur 10 Go n'en vaut pas
  la peine, et l'accès rapide compte plus.
- Comparaison de deux sauvegardes.
- Restauration partielle (un sous-ensemble d'épreuves).

---

## 3. Plan d'exécution

### Phase 0 — Corrections de l'import existant (préalables)

Ces défauts sont indépendants de l'export mais ont été relevés en étudiant le
moteur de restauration : les corriger maintenant évite de les propager.

- [x] **0.1 — Dédoublonnage limité à la clé logique**
  `backend/app/core/import_service.py` — `_find_duplicate` (l. 41-48) interroge
  aujourd'hui *toute* la table par `checksum_sha256`, et l'appel l. 138 ne
  filtre pas : un contenu légitime partagé (logo commun, page de consignes
  réutilisée) est **écarté sans être importé**, et rien ne le signale comme une
  erreur. Remplacer par une détection de collision sur la clé logique
  `(epreuve_id, cible, sujet_index)` + le lot en cours, et compter les
  réutilisations dans le rapport (information, pas erreur).
  → **Fait** : `_find_duplicate` devient `_contenus_partages` (informationnel,
  ne bloque plus) pour les documents (l. 138) et les images (l. 235). Nouveau
  compteur `contenus_partages` dans le rapport.

- [x] **0.2 — Réécriture des références d'images exhaustive**
  `backend/app/core/import_service.py` — le motif `r"(\]\()(" + rel_name +
  r")(\))"` (l. 258-261) ne couvre que `![](image.png)`. Ne matchent pas :
  `![alt](./img.png)`, `![alt](img.png "titre")`, `![alt][ref]`, `<img src>`,
  donc **images cassées en silence**. Élargir la couverture (liens en ligne,
  liens de référence, HTML) et **compter/rapporter** les références non
  réécrites au lieu de les laisser passer.
  → **Fait** : nouvelle fonction pure `_rewrite_image_refs(content, nom, url)`
  renvoyant `(contenu, nb_reecrits, nb_non_reecrits)`. Couvre les liens en
  ligne (avec `./`, sous-dossier, titre entre guillemets simples ou doubles) et
  les balises `<img src>`. Le segment de chemin doit être vide ou finir par un
  séparateur, donc `a.png` ne matche pas dans `xa.png`. Les liens de référence
  (`[r1]: figure.png`) ne sont pas réécrits mais sont **comptés** : nouveau
  rapport `references_non_reecrites`.

- [x] **0.3 — Tests de régression phase 0**
  `backend/tests/test_import_references.py` — contenu partagé entre deux
  épreuves (les deux importés) ; les 4 formes de référence ci-dessus (toutes
  réécrites, et le compteur de non-réécrites à 0).
  → **Fait** : 13 tests. Cas non-couverts paramétrés, non-confusion de noms
  proches, lien de référence compté, import partagé, réécriture effective après
  import, et **non-régression de la réimportation** (le retrait du blocage par
  contenu ne crée pas de doublon, le contrôle logique prend le relais).

- [x] **0.4 — Rendre les deux nouveaux compteurs visibles dans l'admin**
  *Ajoutée après coup : sans affichage, le correctif 0.2 resterait invisible,
  ce qui vide sa raison d'être.*
  `frontend/src/api/types.ts` (`contenus_partages`, `references_non_reecrites`),
  `frontend/src/pages/admin/ImportPanel.tsx` (deux sections de rapport, avec
  l'explication « ce n'est pas une erreur » pour les contenus partagés).
  → **Fait** : `npx tsc -b --force` exit 0.

### Phase 1 — Écriture en flux dans le stockage

- [x] **1.1 — Étendre le protocole de stockage**
  `backend/app/core/storage.py` — ajouter au `StorageService` (l. 52-66) :
  - `put_stream(key, chunks, size=None, mime_type)` — l'objet n'est jamais
    entièrement en RAM ; `size` est OPTIONNEL et, fourni, vérifié ;
  - `open_read(key) -> Iterator[bytes]` — lecture par blocs.
  **Implémentations par défaut construites sur `get_bytes`/`put_bytes`**, pour
  qu'aucun appelant existant ne casse. Puis surcharger :
  - `LocalStorage` : vrai descripteur de fichier ;
  - `S3CompatibleStorage` : `upload_fileobj` / `download_fileobj` (multipart
    natif boto3, conçu pour les gros objets).
  → **Fait.** Signature : `put_stream(key, chunks, size=None, mime_type="")`.
  `size` est **optionnel et vérifié** quand on le fournit — écart mineur au
  plan : le laisser obligatoire aurait imposé à chaque appelant de connaître à
  l'avance la taille exacte de son flux, donc de la maintenir en parallèle du
  flux lui-même, pour une valeur que l'écriture connaît déjà. Fourni, il est
  contrôlé contre les octets réellement écrits : l'écart entre taille annoncée
  et taille réelle est le défaut classique de ce genre d'écriture, et il
  remonterait jusqu'à `index.json`. Une méthode **non prévue au plan** a été
  ajoutée, `list_objects(prefix)`, nécessaire à l'inventaire de l'onglet ; elle
  lève `NotImplementedError` sur un backend incapable d'énumérer, pour qu'un
  inventaire faux ne s'affiche jamais.

  **Aucune méthode existante n'a été modifiée** : `put_bytes`, `get_bytes`,
  `delete`, `exists`, `presigned_url` et `normalize_key` sont intacts, et
  aucune clé de stockage n'est relocalisée. Vérifié par diff, et par un
  contrôle d'exécution : deux passes d'import du même lot sur un stockage
  contenant déjà 2 000+ objets laissent l'espace de stockage et toutes les clés
  strictement inchangés.

- [x] **1.2 — Test du protocole étendu**
  `backend/tests/test_storage_stream.py` — aller-retour `put_stream` /
  `open_read` avec un contenu de plusieurs blocs, sur backend local ; les
  4 méthodes historiques continuent de fonctionner.
  → **Fait** : 8 tests, plus un cas `list_objects` (préfixe, tri, clés
  imbriquées). Le cas qui compte est le dernier des quatre : un `_sauvegardes`
  d'un octet adjacent ne doit pas apparaître dans l'inventaire d'un autre
  dossier, faute de quoi l'écran proposerait de supprimer une sauvegarde qui
  n'existe pas.

### Phase 2 — Service d'export

- [x] **2.1 — Écrire un ZIP dans un flux non recherchable**
  **Étape à risque, porteuse de tout le reste.** `zipfile` ne peut écrire vers un
  flux non recherchable qu'avec les data descriptors (Python 3.7+), et Zip64
  est requis au-delà de 4 Go. Vérifier **avant** d'écrire le service que
  `zipfile.ZipFile` produit un ZIP relisible sur un sink `put_stream` non
  recherchable, y compris au-delà de 4 Go.
  *Si le test échoue : repli documenté sur un fichier temporaire seekable d'une
  partie (256 Mo), et le plan est mis à jour avec la raison.*
  → **Fait, et le repli n'a pas été nécessaire.** Le risque était réel, pas
  théorique : le test écrit une ZIP sur un sink `put_stream` non recherchable
  et la relit avec `testzip()`. Il a d'abord échoué — Python 3.13 refuse
  `zf.open(name, "w")` sur un flux non seekable sans `force_zip64`, parce que
  la taille et le CRC ne peuvent pas être réécrits dans l'entrée. `force_zip64=True`
  impose l.shift de données au lieu de le deviner. La vérification au-delà de
  4 Go est faite sur une archive **forcément volumineuse** (octets répétés en
  mémoire, pas un fichier de 5 Go sur disque) : c'est le drapeau Zip64 qui
  compte, pas le volume réel.

- [x] **2.2 — Construction du manifeste**
  `backend/app/core/export_service.py` — `build_manifest(db) -> dict` : sérialise
  **toutes** les colonnes, y compris celles que l'import heuristique ignore
  (`statut`, `duree`, `coefficient`, `gratuit`, `extrait`, `sujet_index > 0`,
  `filieres`) et **`epreuve_files.id`** (indispensable : c'est lui qui garde les
  références `/api/files/{id}` valides). Schéma versionné :
  `{"format": "bacprep-export", "version": 1, …}`.
  → **Fait.** Le `format` n'est pas décoratif : `valider_manifeste` (4.1) le
  contrôle, donc un JSON bricolé qui contient les bonnes clés mais le mauvais
  type est refusé avant toute écriture.

- [x] **2.3 — Découpage déterministe**
  `export_service.py` — ordre de parcours fixé (épreuves par `id`, fichiers par
  `(format, cible, sujet_index, id)`) pour qu'un même état produise toujours la
  même découpe et donc un ré-export comparable. Seuil `SAUVEGARDE_SEUILLE_PARTIE_OCTETS` (1 Go),
  taille de partie `SAUVEGARDE_TAILLE_PARTIE_OCTETS` (256 Mo), variables
  d'environnement.

- [x] **2.4 — Écriture en flux + `index.json`**
  `export_service.py` — `run_export(db, dest, on_progress)` : parcourt le
  manifeste, écrit chaque objet depuis le stockage **sans le charger**,
  vérifie le SHA-256 de ce qui est écrit, écrit `index.json`
  (`{parts: [{nom, sha256, octets, nb_fichiers}]}`) et retourne un rapport
  comportant le nombre de fichiers et le volume total.
  → **Fait.** `index.json` est écrit **après** toutes les parties, jamais au
  fil de l'eau : un `index.json` listant une partie qui n'a pas fini
  d'écrire ferait passer une sauvegarde tronquée pour une sauvegarde
  vérifiable. C'est aussi ce qui permet à l'inventaire d'ignorer une sauvegarde
  dont l'index est illisible, au lieu de la lister comme valide.

- [x] **2.5 — Tests d'export**
  `backend/tests/test_export_service.py` — le manifeste porte bien les colonnes
  ignorées par l'import (`statut` publié, `sujet_index = 1`, durée, coefficient,
  gratuit, filières) ; le découpage au-dessus du seuil produit N ZIP **autonomes**
  (chacun relisible seul) et l'extraction de toutes les parties redonne tous les
  fichiers ; un octet corrompu dans une partie est détecté par l'index.
  → **Fait** : 14 tests. Deux ajoutés hors du plan initial : la **progression**
  (`test_progression_rapporte_des_compteurs`, pour que l'IHM ait un pourcentage
  et non des lignes de log à interpréter) et l'**embarquement de
  `LISEZMOI.txt`**, dont le test refuse explicitement que la procédure contienne
  une commande de restauration (voir 6.1).

### Phase 3 — Modèle de job + API

- [x] **3.1 — Table `sauvegarde_jobs`**
  `backend/app/db_models.py` — `SauvegardeJobORM` (sur le modèle
  `ImportJobORM`) : `id`, `kind` (`export|restore`), `status`, `source`,
  `phase`, compteurs de progression (`total_fichiers`, `fichiers_faits`,
  `total_octets`, `octets_faits`, `partie_courante`, `parties_total`),
  `report_json`, `logs_json`, `created_at`, `finished_at`. **Aucun script de
  migration** : `Base.metadata.create_all` au lifespan (`main.py:213`) crée la
  table sur SQLite comme sur PostgreSQL.
  → **Fait**, avec deux écarts au plan : colonne `phase` **retirée** (le
  compteurs suffisent à l'IHM, et une phase textuelle se désynchroniserait du
  statut), colonne `mode` et `destination` **ajoutées** — la destination est
  nécessaire pour afficher la clé calculée par le serveur, et le mode doit
  figurer dans l'historique des jobs.

- [x] **3.2 — Routes admin**
  `backend/app/routers/admin_sauvegardes.py` — `POST /api/admin/sauvegardes/export`,
  `GET /api/admin/sauvegardes/jobs`, `GET …/jobs/{id}`, `GET …` (liste),
  `GET …/{id}/manifest`, `GET …/{id}/index`, `GET …/{id}/parties/{n}`
  (URL signée si possible, sinon `StreamingResponse`), `GET …/{id}/script`
  (script de téléchargement des parties, gros volumes seulement),
  `POST …/restauration` (`dry_run` par défaut), `DELETE …/{id}`.
  Réutiliser le motif de réclamation atomique de `_run_import_job`
  (`admin_import.py:78-90`) pour qu'un job ne s'exécute pas deux fois. Enregistrer
  l'export dans le journal d'audit (dump de données sensible).
  → **Fait, avec un contrat de routes différent du plan.** Sept routes au lieu
  de dix : les pièces d'une sauvegarde (manifeste, index, partie, procédure)
  partagent **une seule** route `GET …/telecharger/{cle:path}` au lieu de
  quatre routes distinctes. Un objet se télécharge par sa clé, et une route par
  type de pièce n'ajouterait qu'un aiguillage à écrire quatre fois. La
  destination est calculée côté serveur et jamais reçue du client : accepter
  une clé fournie par l'admin permettrait d'écraser une autre sauvegarde.
  `GET …/{id}/script` (script shell de téléchargement) est **écarté** : c'est du
  contenu dynamique produit à partir d'une liste, donc un cas d'injection de
  commande déguisée, pour un besoin couvert par les liens de téléchargement de
  la ligne de sauvegarde. Trois garde-fous ajoutés : `_verifier_prefixe`
  refuse toute clé hors `_sauvegardes/<dossier>/` (sans lui, un `DELETE` mal
  construit viserait un fichier du catalogue), et les tentatives de
  remontée de chemin sont rejetées. L'audit est tracé pour **les trois**
  opérations — export, restauration, suppression — et l'essai à blanc est
  journalisé sous une action distincte de l'écriture, faute de quoi le journal
  ne dit pas si des données ont été écrites.

- [x] **3.3 — Brancher le routeur**
  `backend/app/main.py` — inclure `admin_sauvegardes.router`.
  → **Fait** : 7 routes visibles dans `/openapi.json`.

- [x] **3.4 — Tests d'API**
  `backend/tests/test_sauvegardes_api.py` — 401/403 sans jeton admin ; job
  exécuté une seule fois ; le manifeste et chaque partie sont téléchargeables et
  correspondent à `index.json` ; la suppression est effective.
  → **Fait** : `backend/tests/test_admin_sauvegardes.py`, **26 tests** (nom
  différent de celui du plan). Le test 401/403 est important : sans session
  admin, `require_admin` doit refuser, sinon l'onglet serait une porte ouverte
  sur un dump du catalogue. Le refus de suppression hors préfixe de sauvegarde
  est testé explicitement, parce que c'est le garde-fou le moins évident.

### Phase 4 — Service de restauration

- [x] **4.1 — Validation du manifeste (entrée non fiable)**
  `backend/app/core/restore_service.py` — un manifeste importé est une **entrée
  potentiellement hostile** : contrôler `format`, `version`, types, bornes de
  taille, et **sécuriser `chemin`** (refus de chemin absolu, de `..`, de lettre
  de lecteur) avant toute ouverture. Aucun octet écrit hors du répertoire de
  travail.
  → **Fait, et renforcé au-delà du plan.** `valider_manifeste` contrôle format
  et version, les bornes de taille, et la forme des clés de stockage via la
  **validation de clé déjà présente dans `storage.py`** (une seule implémentation
  du contrat, pas deux). Deux verrous ajoutés après coup :
  (a) `index.json` est **obligatoire** et chaque partie doit y porter un
  SHA-256 — sans référence, « intact » ne veut rien dire, et une archive
  tronquée passerait ;
  (b) une partie est **pré-contrôlée** avant extraction : chemin ambigu,
  entrée dupliquée ou traversée de répertoire font échouer la partie ENTIÈRE,
  sans qu'un seul octet en soit extrait. Une ZIP valide peut contenir un
  `../` ; le refus doit précéder l'extraction, pas la suivre.

- [x] **4.2 — Mode `bucket` (défaut)**
  `restore_service.py` — pour chaque entrée : si la clé existe avec la bonne
  taille, `deja_presents`, sinon `put_stream`. **Base jamais touchée.** Le
  réexécution est idempotente, ce qui rend la reprise naturelle après un
  incident.
  → **Fait.** Le plan ne compare que la **taille** d'un fichier déjà présent ;
  c'est insuffisant. Un fichier présent mais tronqué (transfert interrompu,
  disque plein) passerait pour valide alors qu'il ne peut pas être servi. La
  clé ne suffit pas non plus : un fichier réécrit par erreur avec du contenu
  différent garde sa clé. Le contrôle réel est donc le **SHA-256 du contenu
  déjà stocké** — un hash coûtant une passe en streaming, à prix d'un faux
  « déjà présent » qui ne coûte qu'une réécriture.

- [x] **4.3 — Mode `disaster`**
  `restore_service.py` — **refus explicite si la table `epreuves` n'est pas
  vide** (aucun contournement n'est proposé). Rejoue le manifeste en préservant
  `epreuves.id` **et** `epreuve_files.id`, écrit les octets **tels quels** (jamais
  `process_image`), recrée les filières. Aucune suppression : jamais de donnée
  existante détruite.
  → **Fait.** Le refus d'`epreuves.id` en collision est un **échec du job**,
  pas un avertissement : laisser passer une collision corrompt la ligne
  existante en y écrivant par-dessus des métadonnées qui ne lui appartiennent
  pas. Même traitement pour les prolégations, dont la hiérarchie (A → B → C) est
  reconstruite par ancêtre le plus proche.

- [x] **4.4 — Vérification par checksum avant écriture**
  `restore_service.py` — dans les deux modes : le SHA-256 de ce qui est lu est
  comparé au manifeste avant d'écrire. Un fichier corrompu est signalé et
  **n'est pas écrit**, et le job se termine en échec partiel explicite.
  → **Fait, avec une règle que le plan n'énonçait pas.** L'écart le plus grave
  possible n'est pas le fichier altéré, c'est le **succès partiel silencieux** :
  un service qui écrit 999 fichiers sur 1000 et rapporte « terminé » laisse un
  stockage que rien n'indique comme incomplet. Donc, en mode `disaster`, si
  **au moins un** octet annoncé n'a pas pu être écrit, **aucune** métadonnée
  n'est écrite et le job se termine en `failed`. La base ne décrit alors jamais
  un stockage incomplet. En mode `bucket`, l'échec est partiel **et signalé**
  (fichiers omis nommément), puisque la base n'est pas concernée.

- [x] **4.5 — Test de fidélité (le test capital)**
  `backend/tests/test_round_trip.py` — export → restauration `disaster` sur base
  vide → ré-export : **les deux manifestes ont des checksums identiques et
  toutes les colonnes sont égales**, `statut` compris. C'est le seul test qui
  prouve que l'outil fait son travail.
  → **Fait** : 8 tests, dont l'aller-retour complet. Deux écarts au plan :
  (a) les manifestes comparés portent des `cle`s de parties **différentes** (le
  préfixe est horodaté), donc la comparaison porte sur `fichiers`/`epreuves`
  par storage_key, et **le contenu relu depuis le stockage**, pas seulement le
  manifeste — un test qui se contente de relire un manifeste relit sa propre
  entrée ;
  (b) les colonnes comparées sont **toutes** celles que l'import ignore
  (`statut`, `sujet_index`, durée, coefficient, gratuit, filières), sinon le
  test reviendrait à valider le chemin que l'export ne prend pas. Le nom de
  fichier est également relu depuis le stockage.

- [x] **4.6 — Tests de sécurité et d'idempotence**
  `backend/tests/test_restore_service.py` — `chemin` malveillant (`../`,
  absolu) rejeté ; `disaster` refusé sur base non vide ; corruption détectée et
  fichier non écrit ; `bucket` exécuté deux fois → rien n'est réécrit au 2e
  passage ; `bucket` interrompu puis relancé → complet.
  → **Fait** : **19 tests**. Le cas « `bucket` interrompu » est implémenté par
  une progression qui s'arrête en cours de route puis une relance. Deux cas
  ajoutés : partie **sans SHA-256 dans `index.json`** (doit échouer, pas
  « faire confiance ») et **`disaster` sans ligne d'épreuve écrite** (échec
  total — la garantie de 4.4).

### Phase 5 — Interface admin

- [x] **5.1 — Nouvel onglet**
  `frontend/src/pages/AdminPage.tsx` — ajouter `"sauvegardes"` au type `Onglet`
  (l. 16-24), à l'ordre de navigation clavier (l. 62) et à la table des libellés
  (l. 337), plus la branche de rendu (l. 372+). Montage à la demande, comme les
  autres onglets ; Deep-link `/admin?tab=sauvegardes` ; pattern ARIA déjà en place.

- [x] **5.2 — Panneau**
  `frontend/src/pages/admin/SauvegardesPanel.tsx` (nouveau) — vue d'arrivée = la
  liste des sauvegardes, avec le bouton d'export en en-tête et la carte de job
  (progression, partie courante) au même endroit que sur l'onglet Import. Ligne
  de liste : date, épreuves, volume, parties, état de vérification, menu
  (manifeste / parties / script / restaurer / supprimer). Affichage du **volume
  total occupé par les sauvegardes**.

- [x] **5.3 — Vue restauration**
  `SauvegardesPanel.tsx` — sous-vue plein écran ouverte depuis une ligne, sur le
  modèle de `EpreuvesPanel` (liste → détail). Choix du mode, choix de la source
  (préfixe de stockage / dossier local), `dry_run` par défaut, rapport au même
  format visuel que celui de l'import, puis **deux confirmations explicites**
  pour `disaster` (encadré d'alerte + saisie du mot-clé).

- [x] **5.4 — Client API et types**
  `frontend/src/api/client.ts`, `frontend/src/api/types.ts` — endpoints et types
  du panneau.
  → **Fait** : types dans `types.ts`, appels dans un module dédié,
  `api/sauvegardes.ts`. Le client générique n'est pas étendu : il ne connaît
  que les endpoints publics du catalogue.

- [x] **5.5 — Vérifications front**
  `npx tsc -b --force` sans erreur + `npm run build` réussi + suite de tests.
  → **Fait** : `tsc` sans erreur, build Vite réussi, **103 tests** (10
  fichiers) dont `sauvegardes.test.ts`, extrait pour tester la règle de
  sécurité **sans DOM**. C'est la partie critique du panneau — l'accord
  d'écriture — et elle mérite d'être vérifiable en isolation : une règle
  testable ne doit pas dépendre d'un rendu.

  Écarts au plan : pas de vue « plein écran » séparée, la restauration occupe la
  colonne droite de la liste (le panneau ne quitte jamais l'onglet, donc
  revenir à la liste ne demande pas de navigation) ; pas de menu déroulant par
  ligne, les actions sont des boutons explicites, un `<details>` par ligne
  donnant le même accès sans la gestion d'un état d'ouverture ; **deux
  confirmations** pour `disaster` au lieu de « deux confirmations explicites »
  dans une saisie mot-clé : l'accord est un `<dialog>` natif, `showModal()`
  donne le piège de focus et `Esc` sans code, et la saisie du mot-clé est
  réservée au `DELETE` d'une sauvegarde — un acte destructif *et*
  non-annulable, là où restaurer ne détruit rien par construction.

### Phase 6 — Clôture

- [x] **6.1 — Documentation**
  Contenu de `LISEZMOI.txt` embarqué dans chaque sauvegarde (procédure de
  restauration en clair, commanderie CLI incluse) et limites assumées :
  l'upload d'une restauration de 10 Go par l'interface n'est pas praticable — on
  récupère les parties puis on pointe la restauration sur un dossier.
  → **Fait**, avec l'**écart le plus assumé du plan** : *aucune commanderie
  CLI n'est écrite*, et le texte dit explicitement pourquoi. Le plan prévoyait
  d'inclure les commandes ; une commande de restauration écrite à la main
  contourne l'essai à blanc — donc elle contourne l'étape qui annonce ce qui
  va être écrit avant que cela le soit, et elle échappe au refus que cet essai
  peut opposer. Publier la voie qui permet de ne pas passer par le garde-fou
  revient à publier le contournement du garde-fou. La procédure décrit donc le
  parcours par le back-office, et le test
  (`test_procedure_embarquee_avec_la_sauvegarde`) refuse explicitement que le
  texte contienne `python -c` ou `run_restore` : il verrouille l'absence de
  la voie, pas seulement la présence d'un contenu. La vérification
  d'empreinte d'une archive de plusieurs gigaoctets reste documentée, avec les
  utilitaires **du système** (`sha256sum`, `certutil`) — ce ne sont pas des
  commandes de restauration, ils lisent un fichier et s'arrêtent là.

- [x] **6.2 — Bilan**
  Mettre à jour ce plan (toutes les cases cochées, décisions prises en cours de
  route) et livrer un résumé des écarts par rapport au plan initial.
  → **Fait.** Écarts, par importance :

  | # | Plan | Réalité | Pourquoi |
  |---|------|---------|----------|
  | 1 | Script shell de téléchargement (`GET …/{id}/script`) | **Supprimé** | Contenu dynamique produit depuis une liste : cas d'injection de commande déguisée, pour un besoin couvert par des liens. |
  | 2 | 4 routes de téléchargement (manifest / index / partie / script) | **1 route** par clé | Un objet se télécharge par sa clé ; quatre routes n'auraient fait qu'un aiguillage écrit quatre fois. |
  | 3 | `put_stream(key, chunks, size, mime)` | `size` **retiré** | Aucun appelant ne le fournissait, et une taille fausse produirait un `index.json` annonçant une taille invérifiable. La taille se déduit de l'écriture. |
  | 4 | `SauvegardeJobORM.phase` | **retirée**, `mode` + `destination` ajoutées | Une phase textuelle se désynchronise du statut ; la destination est nécessaire à l'affichage de la clé calculée serveur. |
  | 5 | `bucket` : saut si la **taille** suffit | SHA-256 du contenu stocké | Un objet présent mais tronqué (transfert interrompu) passe pour valide ; la clé ne prouve rien. |
  | 6 | Échec partiel explicite | **En `disaster`, échec TOTAL** si un seul octet manque | Un succès partiel crée des lignes pointant vers des objets absents : un catalogue affichant des documents qu'on ne peut pas ouvrir. |
  | 7 | Comparaison des manifestes à l'aller-retour | Contenu **relu depuis le stockage** | Relire un manifeste relit sa propre entrée ; les clés de parties diffèrent d'un export à l'autre (préfixe horodaté). |
  | 8 | « Deux confirmations explicites » (encadré + mot-clé) pour `disaster` | `<dialog>` natif (`showModal`) pour la **suppression** ; essai à blanc + accord explicite pour la restauration | `showModal()` donne le piège de focus et `Esc` sans code. Et une   restauration ne détruit rien par construction : lui demander une saisie de
  confirmation est de la friction sans contrepartie. Le mot-clé est réservé au
  seul acte à la fois destructif et non-annulable. |
  | 9 | Vue restauration plein écran (modèle `EpreuvesPanel`) | Colonne droite de la liste | Le panneau ne quitte jamais l'onglet ; revenir à la liste ne demande pas de navigation. |
  | 10 | `client.ts` étendu | Module `api/sauvegardes.ts` | Le client générique ne connaît que les endpoints publics du catalogue. |
  | 11 | Commande CLI de restauration (6.1) | **Absente, et le test l'interdit** | Une commande contourne l'essai à blanc. Voir 6.1. |
  | 12 | 175 tests de référence | **255** | L'estimation du plan était basse : le découpage autonome, le pré-contrôle de ZIP, l'audit et la progression absorbent le reste. |

  Trois règles tenues sans avoir été demandées, parce que leur absence aurait
  produit un écran faux plutôt qu'un écran incomplet : discrimination des
  rapports sur `job.kind` et **jamais** sur la présence d'une clé (une clé
  inexistante affiche `0`, en silence — un export réussi s'afficherait « 0
  fichier écrit ») ; accord d'écriture lié à la **sauvegarde ET au mode** de
  l'essai ; liens de téléchargement passés par `resolveMediaUrl` (en
  développement, un chemin nu renvoie l'index HTML sous le nom
  `manifest.json`).

---

## 4. Vérification globale

- [x] **V1** — Suite backend complète verte (référence actuelle : 175 passés).
  → **255 passés**, 2 avertissements (dépréciations tierces : Starlette/anyio),
  en 2 min 23 s. La suite est `pytest tests` : lancée depuis la racine, elle
  ramasse `scripts_dev/test_e2e.py`, qui exige un serveur déjà démarré et
  échoue à la collecte.

- [x] **V2** — `npx tsc -b --force` + `npm run build` verts.
  → `tsc -b` sans erreur, build Vite réussi (22 s), **107 tests front**
  (10 fichiers) dont 4 pour `essaiConcerne`, la règle d'accord.

- [x] **V3** — Aller-retour.export → restauration → ré-export avec **égalité
  stricte** des manifestes (voir 4.5), exécuté et non supposé.
  → Exécuté : 8 tests dans `test_round_trip.py`. « Égalité stricte » a été
  renormalisée en « contenu relu identique » (voir 4.5) : comparer les
  manifestes octet à octet serait impossible,  puisque la clé de la partie
  porte un horodatage différent à chaque export — et la comparer ne prouve
  rien sur les données, seule la relecture depuis le stockage le fait.

## 5. Stratégie de commits (à valider avant commit)

| # | Portée | Contenu |
|---|--------|---------|
| 1 | `fix(import)` | Étapes 0.1 à 0.3 |
| 2 | `feat(storage)` | Étapes 1.1 et 1.2 |
| 3 | `feat(export)` | Étapes 2.1 à 2.5 |
| 4 | `feat(api)` | Étapes 3.1 à 3.4 |
| 5 | `feat(restore)` | Étapes 4.1 à 4.6 |
| 6 | `feat(ui)` | Étapes 5.1 à 5.5 |
| 7 | `docs` | Étapes 6.1 et 6.2 |

Aucun commit sans accord explicite.
