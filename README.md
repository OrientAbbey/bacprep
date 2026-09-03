# Copies & Corrigés — BacPrep Cameroun

Application d'annuaire d'épreuves du **secondaire camerounais** (6e →
Terminale : séquences, compositions, BEPC, Probatoire, BAC, examens
blancs...) : chaque épreuve est un fichier **Markdown + images** stocké
dans un stockage objet (Cloudflare R2 en production), classé par
niveau/classe/évaluation/matière/série en base. Navigation publique
Accueil → Niveau → Classe → Catalogue, recherche globale, import massif
(CLI ou zip admin), assistant IA contextuel, abonnements payants
simulés (Orange Money / MTN MoMo), back-office de publication. Voir
`CAHIER_DES_CHARGES.md` pour la spécification produit et `DEPLOIEMENT.md`
pour les cibles de déploiement.

## Architecture (réf. `architecture technique.txt`)

```text
React/Vite ──HTTPS──► FastAPI
                        ├── SQLAlchemy → SQLite (dev) / PostgreSQL (prod)
                        └── Storage Service → Cloudflare R2 (prod) / disque local (dev)
                                              epreuves/{niveau}/{annee}/{epreuve_id}/
                                                ├── sujet.md
                                                ├── corrige.md
                                                └── images…
```

- La classification métier (classe, évaluation, matière, séries) vit en
  BASE — l'arborescence du stockage ne reflète que
  `niveau/année/épreuve` ;
- la base ne conserve que les métadonnées + `storage_key`, jamais le
  contenu ;
- fichiers privés servis par `GET /api/files/{id}` (vérification des
  droits, URL signées HMAC ; redirection vers URL signée R2 en prod).

## ⚠️ Refonte v3 — classification secondaire complète, stockage objet, import massif

Le projet a été refondu conformément à `architecture technique.txt` et au
prompt d'amélioration : épreuves Markdown + images dans un stockage objet
(local en dev, Cloudflare R2 en prod), classification complète
(niveau/classe/évaluation/séries multi-filières), navigation publique
Accueil → Niveau → Classe → Catalogue avec recherche globale, abonnements
scopés à la classe, import massif (CLI + upload zip admin), barre de
défilement des onglets de l'assistant révélée au survol. Le backend et le
frontend ont été testés en local (uvicorn + smoke tests API + `npm run
build`) — re-tester le parcours de démonstration ci-dessous avant tout
déploiement. La base de développement (`backend/data/bacprep.db`) a été
régénérée : les tables et le modèle de données changent profondément
(`epreuve_files`, `import_jobs`, `subscriptions.classe`...).

## Démarrage local

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Au premier démarrage, les 3 épreuves d'exemple sont automatiquement
importées depuis `backend/data/epreuves/{sujets,corriges}/`.

Vérifier : `curl http://localhost:8000/api/health` → `{"status":"ok",...}`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Ouvrir `http://localhost:5173`. Se connecter en mode simulé (n'importe
quel email/nom).

### Build de production (service unifié)

```bash
cd frontend && npm run build
cd ../backend && uvicorn app.main:app --port 8000
```

Une fois `frontend/dist` présent, le backend le sert directement sur `/`
(voir `DEPLOIEMENT.md`).

## Parcours de démonstration — élève

1. Ouvrir `http://localhost:5173` : l'accueil PUBLIC propose les classes du
   secondaire (cartes sans épreuve désactivées) et une recherche globale.
2. Cliquer sur « Terminale » : le catalogue de la classe, avec filtres
   dynamiques (série, matière, année, évaluation).
3. La recherche globale (« histoire ») affiche des résultats de TOUTES les
   classes, indépendamment de la navigation courante.
4. Ouvrir une épreuve gratuite directement ; une épreuve payante redirige
   vers `/connexion` (navigation publique) puis vers l'abonnement.
5. Choisir un moyen de paiement → "Continuer vers le paiement" → simuler
   la confirmation du webhook.
6. Sélectionner un passage de texte → bouton flottant → poser une question
   à l'assistant (mode démonstration si aucune clé Gemini/Groq n'est
   configurée).
7. Page Profil → voir l'abonnement actif (scopé à sa classe), l'annuler.

## Parcours de démonstration — admin

1. Aller sur `/admin`, se connecter avec l'email listé dans `ADMIN_EMAILS`
   et le jeton `ADMIN_TOKEN` (`admin123` par défaut).
2. Créer une épreuve : selects Niveau/Classe/Évaluation, séries par puces
   (multi-sélection), sujet/corrigé en Markdown, upload d'images.
3. Publier (nécessite un sujet et au moins une série).
4. Onglet **Import massif** : uploader une archive zip d'un dossier
   organisé `{annee}/{classe}/{matiere}/*.md` — rapport détaillé à la fin
   (créées, doublons, métadonnées manquantes, erreurs). Alternative CLI :
   `python -m app.scripts.importer --dir backend/data/imports`.
5. Relire les épreuves importées (elles arrivent en brouillon) puis les
   publier.

## Import massif — format attendu

```text
mon-dossier/
└── 2023/
    └── Terminale/
        └── Mathématiques/
            ├── bac-D-sujet.md
            ├── bac-D-corrige.md
            └── figure1.png
```

Le moteur (backend/app/core/import_service.py) parcourt récursivement,
identifie sujet/corrigé par le nom (`corrige` → corrigé), déduit
année/classe/matière/série/évaluation de l'arborescence, crée les entrées
en base (brouillon), copie les fichiers vers le stockage définitif,
génère les storage_key, détecte les doublons par SHA-256 et signale les
fichiers aux métadonnées insuffisantes.

## Historique des corrections (après retours d'usage)

Plusieurs séries de corrections ont été apportées après la livraison
initiale, au fil de retours d'usage successifs. Détail chronologique
ci-dessous (les problèmes les plus significatifs, avec leur cause
identifiée quand elle a pu être déterminée avec certitude).

### Série 1 — contrastes, sélection, session admin

1. **Contraste au survol** — les boutons "Assistant", "Demander à l'assistant"
   et "Connexion avec Google" pouvaient devenir illisibles au survol en mode
   sombre. Corrigé en déclarant `color-scheme` explicitement (`:root`/`.dark`)
   et en répétant les couleurs de texte sur `:hover`/`:focus-visible` pour
   chaque bouton à couleurs fixes ; le bouton Google suit désormais lui-même
   le thème actif (`filled_black` en sombre, `outline` en clair).
2. **Panneau assistant adaptatif + disposition** — le panneau suit le thème
   clair/sombre de la page (il ne reste plus toujours sombre). Sur bureau,
   il s'ouvre **à côté** du contenu (colonne latérale) plutôt qu'en
   recouvrement par-dessus ; sur mobile, feuille modale plein écran.
3. **Refonte des bulles de discussion** — rendu Markdown/LaTeX/tableaux qui
   ne dépasse plus jamais de la bulle. La sélection de texte dans le lecteur
   envoie le **Markdown brut** du passage (formules, tableaux, images
   comprises) à l'assistant plutôt que le texte affiché nettoyé.
4. **Badges compacts** — une épreuve multi-filières affiche un seul badge
   listant toutes ses filières (ex. `A,C,E`) ; le badge "corrigé disponible"
   devient une puce icône + texte court.
5. **Images dans le contexte envoyé à l'assistant** — si le passage
   sélectionné contient une image, le backend la transmet en pièce jointe à
   Gemini (fournisseur multimodal) ; avec Groq (texte seul), une note
   explicite signale qu'une image a été ignorée.
6. **Persistance du verrou admin** — la session admin unique est stockée en
   base (table `admin_lock`) plutôt qu'en mémoire : un redémarrage du
   backend ne libère plus silencieusement l'accès administrateur.
7. **Correctifs supplémentaires** — bug d'arithmétique de dates (SQLite
   perdait le fuseau horaire, corrigé par un type `UTCDateTime` dédié),
   sélection de texte cassée par un `user-select: none` trop large, double
   création de conversation à l'ouverture du panneau (garde React contre le
   double-effet de StrictMode), anneau de focus clavier ajouté (absent
   auparavant), navigation clavier complète dans les listes déroulantes,
   abonnement proposé à tort pour une épreuve déjà gratuite/couverte
   (nouveau contrôle `GET /api/subscriptions/deja-couvert`).

### Série 2 — bug d'authentification admin critique, streaming

8. **`api.get()` ignorait tout en-tête personnalisé** — bug trouvé : le
   client HTTP frontend n'acceptait un en-tête (`X-Admin-Session`) que sur
   `post`/`put`/`del`, jamais sur `get`. Résultat : `GET /api/admin/epreuves`
   partait sans jeton et échouait en 401 juste après une connexion admin
   pourtant réussie (200). Corrigé, et l'appel `.env` a aussi été rendu
   robuste (`load_dotenv()` sans chemin explicite ne trouvait `.env` que si
   `uvicorn` était lancé depuis `backend/` — désormais résolu en absolu).
9. **Réponses en streaming, activé par défaut** — l'assistant répond
   maintenant au fur et à mesure de sa génération. Voir section dédiée
   ci-dessous.
10. Documentation complète (docstrings) ajoutée sur l'ensemble des fonctions
    backend restées sans commentaire.

### Série 3 — back-office, catalogue, accessibilité

11. **Miniatures d'images cassées en admin** — bug trouvé : les vignettes
    utilisaient des URL relatives (`/media/...`), qui pointent vers le
    frontend en développement (origine différente du backend) plutôt que
    vers le fichier réel. Corrigé via un helper `resolveMediaUrl` réutilisé
    aussi dans le rendu Markdown du lecteur (même bug affectait les images
    insérées dans une épreuve).
12. **Bascule "Rendu" de l'admin n'affichait pas de Markdown rendu** — elle
    injectait le texte brut tel quel dans une simple `<div>` sans jamais
    appeler le moteur de rendu. Corrigé (utilise désormais `MarkdownContent`).
13. Boutons **×** (retirer, supprime le fichier et la balise Markdown) et
    **+** (insérer/réinsérer la balise) ajoutés sur chaque vignette d'image.
14. Système de notifications toast (haut-droite) remplaçant les messages de
    confirmation auparavant affichés en haut de formulaire (peu visibles) ;
    appliqué aux actions admin et aux connexions/déconnexions.
15. Barre de recherche + limite de chargement (30 par défaut) dans la liste
    latérale du back-office ; carte sélectionnée mise en surbrillance.
16. Pagination du catalogue (24 par page + "Voir plus") ; horodatage relatif
    ("Consulté il y a 3 j") remplaçant la mention statique "Déjà consultée".
17. Ajout d'un état `:active` visible au clic et surtout d'un `cursor:
    pointer` explicite sur tous les éléments cliquables — un `<button>` HTML
    n'a **pas** ce curseur par défaut dans la plupart des navigateurs
    (contrairement à une idée reçue), ce qui expliquait en grande partie
    l'impression d'interface "morte" au clic.

### Série 4 — contrastes restants, comportements de sélection, refontes visuelles

18. **Nouveau bug de contraste identifié et corrigé** — `text-highlight-ink`
    est un token **fixe** pensé pour du texte posé sur le fond `highlight`
    (jaune vif, ne change pas de teinte entre les deux thèmes) ; il était
    utilisé par erreur sur `bg-highlight-soft` (qui, lui, devient très
    sombre en mode sombre), rendant le texte quasi illisible. Touchait la
    bulle de message utilisateur, le bouton "Voir tout" du contexte, et la
    carte "Paiement en attente" de la page Abonnement. Remplacé par
    `text-ink` (adaptatif) partout où c'était le cas.
19. Avatars (élève / assistant) ajoutés de part et d'autre des bulles de
    discussion.
20. **"Copier dans le chat"** — comportement différencié selon que le
    panneau assistant est ouvert ou fermé lors d'une nouvelle sélection de
    texte : fermé → nouvelle discussion (comme avant) ; ouvert → colle le
    texte dans le champ de saisie **sans jamais toucher au contexte** de la
    discussion en cours (une version intermédiaire avait, à tort, remplacé
    ce contexte).
21. **Bug vérifié et corrigé** : recherche insensible aux accents dans le
    back-office (`GET /api/admin/epreuves?q=...`). Cause identifiée avec un
    test autonome : la fonction `LOWER()` native de SQLite est ASCII-only
    (`LOWER('Éducation')` reste `'Éducation'`), ce qui cassait silencieusement
    toute recherche `.ilike()` sur du texte accentué. Une fonction Python
    (Unicode-correcte) est désormais enregistrée à la place au niveau de la
    connexion SQLite.
22. Nouveau statut d'accès **"Ouvert"** (cadenas ouvert, à côté de
    "Gratuit"/"Payant") : une épreuve payante déjà couverte par un
    abonnement actif de l'utilisateur l'affiche, calculé côté frontend à
    partir de `GET /api/subscriptions/mine` (voir `lib/access.ts`).
23. Carte récapitulative de la page Abonnement redessinée (bandeau prix +
    phrase de synthèse + tuiles à icônes) plutôt qu'un tableau à deux
    colonnes ; ajout de liens "Ouvrir l'épreuve"/"Voir le catalogue" et
    "Aller à mon profil" après confirmation du paiement.
24. Avatar à initiales (ex. "FA" pour "Franck Albert") remplaçant l'icône
    générique dans l'en-tête et la page profil.
25. Placeholders explicites ajoutés sur tous les champs de formulaire
    (admin, connexion élève et admin).
26. Formulaires (connexion admin, édition d'épreuve) enveloppés dans de
    vraies balises `<form>` : la touche Entrée ne déclenchait aucune
    soumission auparavant, faute de formulaire réel.

### Série 5 — LaTeX, défilement des onglets, recherche unifiée

27. **LaTeX toujours cassé sur certaines réponses, cause identifiée** :
    `remark-math` traite `$$...$$` comme un CONSTRUIT DE BLOC (à la manière
    d'un bloc de code), pas comme un délimiteur utilisable au milieu d'un
    paragraphe — un modèle qui écrit une formule `$$...$$` sans saut de
    ligne isolant ce bloc produit un texte que le moteur ne reconnaît pas
    comme formule et laisse tel quel (backslashes compris). Corrigé en
    forçant, côté frontend, chaque bloc `$$...$$` à être isolé sur ses
    propres lignes entourées de lignes vides, quelle que soit la manière
    dont le modèle l'a formaté à l'origine (voir `lib/latex.ts`).
28. **Bug de défilement des onglets de discussion, cause identifiée et
    corrigée** : l'en-tête du panneau assistant est passé d'une disposition
    flexbox (`flex-1 min-w-0`, qui pouvait laisser toute la ligne déborder
    plutôt que confiner le défilement au bon élément selon les navigateurs)
    à une grille CSS (`grid-cols-[minmax(0,1fr)_auto_auto_auto]`), un motif
    plus robuste pour ce cas précis. Un nouvel onglet créé fait aussi
    maintenant défiler automatiquement la barre pour le rendre visible.
29. **Bug de collage intempestif du texte sélectionné, cause identifiée et
    corrigée** : un panneau assistant fraîchement ouvert réappliquait à tort
    la dernière sélection de texte au champ de saisie, même sans nouvelle
    sélection — la référence de garde (`nonce` de la dernière sélection
    traitée) démarrait à `null` sur chaque nouveau montage, alors que le
    signal reçu en prop pouvait déjà être non-nul (valeur laissée par une
    interaction précédente). Corrigée par une double protection : la
    référence est désormais initialisée avec le nonce déjà présent au
    montage (ne traite que les nonces réellement nouveaux), et le parent
    (ViewerPage) réinitialise aussi ce signal à chaque fermeture du panneau.
30. Champ de saisie du chat devenu multi-ligne (Entrée envoie, Maj+Entrée
    insère un saut de ligne), avec hauteur qui grandit jusqu'à un maximum.
31. Recherches insensibles aux accents généralisées ("éducation" trouve
    "Éducation") : le correctif SQLite de la série 4 va plus loin
    (décomposition Unicode + suppression des diacritiques, pas seulement la
    casse) et un équivalent JavaScript (`lib/text.ts`, `foldText`) est
    utilisé côté frontend pour les recherches locales (menus déroulants,
    sélecteur d'épreuve de la page Abonnement).
32. Filtre "Accès" du catalogue enrichi d'un quatrième statut, "Ouvert" (en
    plus de Tous/Gratuit/Payant).


## Réponses en streaming (activé par défaut)

L'assistant IA répond désormais **au fur et à mesure de sa génération**
plutôt qu'en un seul bloc après une attente silencieuse — perçu comme
nettement plus réactif, en particulier sur une connexion mobile lente
(persona élève camerounais, voir `CAHIER_DES_CHARGES.md`).

- **Backend** : nouvel endpoint `POST /api/assistant/ask/stream`
  (Server-Sent Events, `text/event-stream`), qui consomme les endpoints de
  streaming natifs de Gemini (`:streamGenerateContent?alt=sse`) et de Groq
  (API compatible OpenAI, `stream: true`) — les deux sont supportés par
  l'ensemble de leur catalogue de modèles de chat, pas seulement certains
  modèles précis. L'endpoint historique `POST /api/assistant/ask`
  (réponse complète, non-streaming) reste disponible pour compatibilité.
- **Frontend** : `AssistantPanel` utilise le streaming par défaut
  (`lib/streaming.ts`), affichant le message de l'assistant qui se
  remplit progressivement, avec réconciliation finale sur l'état exact
  persisté côté serveur une fois le flux terminé.
- **Limite connue** : la liste des modèles supportant le streaming
  (`STREAMING_UNSUPPORTED_MODELS` dans `backend/app/core/assistant.py`)
  n'a pas pu être vérifiée en direct contre la documentation officielle
  des limites de débit de Groq au moment de la rédaction (environnement
  sans accès réseau sortant) — à revérifier avant mise en production si
  un modèle Groq non standard est configuré via `GROQ_MODEL`.

## Limitations connues

| Limitation | Détail |
|---|---|
| Chiffrement au repos | Contenu stocké en clair dans le stockage objet — à traiter avant un usage au-delà de la démonstration. |
| Mode hors-ligne | Hors périmètre de ce prototype (voir `CAHIER_DES_CHARGES.md` §7 pour la solution envisagée en phase suivante). |
| Paiement réel | Simulé par un bouton ; voir `PAIEMENT.md` pour l'intégration Notch Pay/Monetbil réelle. |
| Ingestion PDF automatique | Hors périmètre : les épreuves sont exclusivement Markdown + images (voir prompt d'amélioration). |
| Application Android (Capacitor) | Hors périmètre de ce prototype ; note d'intégration dans `PROMPT_DESIGN_BULLETIN_OFFICIEL.md` §7. |
| Comptes admin multi-rôles | Un seul niveau "admin", restreint par liste d'emails. |
| Filtre "Ouvert"/"Payant" du catalogue + pagination | Le statut "Ouvert" est calculé côté client après la pagination serveur (24 épreuves/page) : une page peut afficher moins de 24 cartes une fois filtrée si "Ouvert" ou "Payant" est rare dans cette page. "Voir plus" reste basé sur la présence de données côté serveur, pas sur le nombre de cartes affichées après ce filtre. |
| Isolation automatique des blocs `$$...$$` | `lib/latex.ts` force chaque bloc `$$...$$` sur ses propres lignes pour que `remark-math` le reconnaisse — best-effort, pas un vrai parseur LaTeX ; certaines constructions très inhabituelles peuvent encore échapper à cette normalisation. |

## Structure du projet

Voir `PROMPT_RECONSTRUCTION.md` section 3 pour l'arborescence de référence
que ce projet suit.

## Documents de spécification inclus

- `CAHIER_DES_CHARGES.md` — spécification produit complète.
- `PROMPT_RECONSTRUCTION.md` — prompt de reconstruction (architecture,
  backend, modèle de données, tests).
- `PROMPT_DESIGN_BULLETIN_OFFICIEL.md` — spécification visuelle faisant
  autorité (remplace la section 6.1 du document précédent).
- `DEPLOIEMENT.md` + `render.yaml` — déploiement.
- `PAIEMENT.md` — intégration du paiement réel.
