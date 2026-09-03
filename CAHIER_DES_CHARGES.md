# Cahier des Charges
## Application d'aide à l'apprentissage pour les classes de Terminale (Cameroun)
### Préparation aux examens — Épreuves, corrigés et assistant IA

**Version 2.3 — Document de spécification, mis à jour après plusieurs séries de retours d'usage sur le prototype fonctionnel**

### Journal des versions

| Version | Contenu |
|---|---|
| 1.0 | Spécification initiale complète (Modules 1 à 9), études comparatives, grille tarifaire. |
| 2.0 | Journalisation applicative, images jointes, assistant multi-discussions persistées et plafonnées, portée d'abonnement supplémentaire, profil utilisateur, historique de consultation, notifications temps réel (WebSocket), mode clair/sombre. Détail en section 12. |
| 2.1 | Correctifs de contraste, préremplissage et récapitulatif de l'abonnement, filtre année par défaut, profil enrichi avec annulation, authentification Google réelle activable, mise à jour des modèles IA avec journalisation détaillée, audit d'accessibilité, script de déploiement de test. Détail en section 13. |
| 2.2 | Restructuration du stockage des données (dossier unique), épreuves multi-filières, fusion du sujet et du corrigé en une seule entité, reconnexion WebSocket automatique, correctif de contraste du panneau assistant, verrou de session admin avec liste d'emails autorisés, révélation progressive du paiement, optimisations de performance (base de données, fichiers, appels IA), déploiement unifié gratuit (retrait de Vercel au profit de Render), guide d'intégration du paiement réel. Détail en section 14. |
| 2.3 (cette version) | Réponses de l'assistant en streaming, envoi d'images en contexte à l'IA, persistance du verrou admin en base, nouveau statut d'accès "Ouvert", refonte du panneau assistant (contraste, avatars, disposition à côté du contenu, vue plein écran, défilement des onglets, champ multi-ligne), recherche insensible aux accents, back-office enrichi (recherche, pagination, notifications toast, gestion fine des images), correctifs d'accessibilité clavier et de contraste, nombreux bugs corrigés et documentés avec leur cause identifiée. Détail en section 15. |

---

## 0. Résumé exécutif

L'application permet aux élèves de Terminale camerounais de consulter des épreuves d'examen (Baccalauréat, et plus tard séquences) accompagnées de leurs corrigés, classées par filière, matière et année. Un assistant IA contextuel répond aux questions de l'utilisateur sur un passage précis d'une épreuve ou d'un corrigé, via sélection/surlignage du texte concerné — ou sur l'épreuve entière si aucun passage n'est sélectionné. L'accès est soumis à un modèle d'abonnement flexible (par épreuve, matière+année, matière, année ou filière complète), payé via Orange Money / MTN Mobile Money par le biais d'un agrégateur. L'application cible Android et Web, avec un mode hors-ligne pensé comme fonctionnalité centrale.

---

## 1. Objectifs et périmètre

### 1.1 Objectifs du MVP (premier prototype fonctionnel)

1. Permettre à un élève de créer un compte via Google OAuth et de parcourir un catalogue d'épreuves classées par filière / matière / année.
2. Afficher les épreuves et corrigés dans un lecteur sécurisé (pas le PDF brut), avec protection contre la capture d'écran et le vol de contenu.
3. Permettre à l'utilisateur de sélectionner un passage de texte et de poser une question à l'assistant IA à ce sujet.
4. Permettre la souscription à un abonnement (scope flexible) et son paiement via Orange Money / MTN MoMo par agrégateur.
5. Garantir une session unique par utilisateur, avec notification explicite en cas de déconnexion forcée.
6. Permettre une consultation hors-ligne du contenu déjà synchronisé, avec renouvellement automatique de la clé d'accès.

### 1.2 Périmètre explicitement inclus dans le MVP

- Plateformes : **Android** (via Capacitor) et **Web** (responsive).
- Contenu : épreuves du **Baccalauréat** uniquement (les séquences seront ajoutées en phase 2).
- Sous-système : **francophone** (filières C, D, E, A...). Le GCE anglophone est hors périmètre MVP.
- Authentification : **Google OAuth uniquement**.
- Paiement : Orange Money + MTN MoMo via un agrégateur unique (CinetPay, Notch Pay, FeexPay ou PawaPay — à sélectionner selon disponibilité et frais).

### 1.3 Hors périmètre du MVP (phases suivantes)

- Épreuves de séquences (non-Bac).
- Sous-système anglophone (GCE).
- Statistiques d'apprentissage avancées / recommandations personnalisées.
- Mode multi-appareils (au-delà d'une session unique).
- Application iOS.

---

## 2. Utilisateurs et parcours

### 2.1 Persona principal

Élève de Terminale, connexion mobile instable et coûteuse en data, budget limité, cherchant à réviser efficacement pour le Bac à l'aide d'épreuves antérieures et d'explications ciblées sur ce qu'il ne comprend pas.

### 2.2 Parcours utilisateur principal

1. L'élève installe l'app (ou visite le site web) → se connecte via Google.
2. Il consent explicitement à la politique de confidentialité (obligatoire au premier lancement).
3. Il navigue le catalogue par filière → matière → année, ou effectue une recherche.
4. Il tombe sur une épreuve verrouillée (non souscrite) → voit un aperçu limité + bouton "S'abonner".
5. Il souscrit un abonnement adapté à son besoin (une épreuve, une matière, une année ou toute la filière) → paie via Orange Money/MTN MoMo.
6. Une fois l'abonnement confirmé, il accède à l'épreuve et à son corrigé dans le lecteur sécurisé.
7. En cas d'incompréhension sur un passage, il le sélectionne et ouvre l'assistant IA via le bouton flottant → pose sa question → reçoit une explication contextualisée.
8. Il peut continuer à consulter l'épreuve hors-ligne pendant une période limitée après sa dernière connexion.

---

## 3. Architecture générale

### 3.1 Vue d'ensemble

```
┌─────────────────┐     ┌─────────────────┐
│   App Android    │     │    App Web       │
│   (Capacitor)     │     │   (même codebase)│
└────────┬─────────┘     └────────┬─────────┘
         │                        │
         └───────────┬────────────┘
                      │  HTTPS / REST
              ┌───────▼────────┐
              │  Backend API     │  (FastAPI - Python)
              │  - Auth          │
              │  - Catalogue     │
              │  - Abonnements   │
              │  - Paiement      │
              │  - Assistant IA  │
              └───────┬────────┘
       ┌──────────────┼──────────────────┐
       │               │                   │
┌──────▼─────┐  ┌──────▼──────┐   ┌───────▼────────┐
│ Base de      │  │ Stockage      │   │ Agrégateur       │
│ données       │  │ contenu       │   │ paiement         │
│ (Firestore/   │  │ structuré     │   │ (CinetPay/       │
│  PostgreSQL)  │  │ chiffré       │   │  Notch Pay...)   │
└──────────────┘  └──────────────┘   └────────────────┘
                                              │
                                      ┌───────▼────────┐
                                      │  LLM API          │
                                      │ (assistant IA,    │
                                      │  texte seul)      │
                                      └────────────────┘
```

### 3.2 Stack technique recommandée

| Composant | Choix recommandé | Justification |
|---|---|---|
| Client mobile + web | **Capacitor** (une seule codebase) | Cohérent avec l'expérience acquise sur KWA-WATT ; évite de dupliquer le développement Android/Web |
| Authentification | **Firebase Auth** (Google OAuth) | Intégration native avec Capacitor, gestion des tokens simplifiée |
| Base de données | **Firestore** (MVP) ou PostgreSQL si besoin de requêtes relationnelles complexes plus tard | Firestore accélère le développement du prototype ; migration possible en phase 2 si les jointures (abonnements ↔ catalogue) deviennent trop complexes |
| Backend API | **Python / FastAPI** | Cohérent avec l'expérience JARVIS ; bon écosystème pour l'orchestration IA (LangChain déjà maîtrisé) |
| Stockage contenu structuré | Firebase Storage (chiffré) ou bucket S3-compatible | Fichiers Markdown/JSON structurés + assets image extraits |
| Paiement | **Notch Pay** (primaire) + **Monetbil** (repli si compte entreprise non encore enregistré) | Voir étude comparative détaillée, section 10.1 |
| Assistant IA | **Gemini Flash** (primaire, gratuit) + **Groq/Llama** (repli gratuit) | Voir étude comparative détaillée, section 10.2 |
| Notifications | Firebase Cloud Messaging | Cohérent avec Firebase, gratuit pour le volume du MVP |

---

## 4. Modules fonctionnels

### Module 1 — Authentification & Sessions

**Fonctionnalités :**
- Connexion via Google OAuth. **(v2.1) Deux implémentations coexistent, choisies par une seule variable d'environnement backend (`AUTH_MODE=mock|google`)** — le frontend interroge `GET /api/auth/config` pour savoir laquelle afficher, évitant de dupliquer ce réglage entre deux fichiers `.env` :
  - `mock` (défaut) : formulaire simulé, pour développer/démontrer sans dépendre d'un projet Google Cloud.
  - `google` : vraie connexion via Google Identity Services côté client, avec vérification du ID token JWT côté serveur (bibliothèque `google-auth`) avant création de la session — voir Module 1, section technique. Si `AUTH_MODE=google` est défini sans `GOOGLE_CLIENT_ID` valide, le serveur journalise un avertissement et retombe automatiquement sur le mode simulé plutôt que de casser la connexion.
- Création automatique du profil utilisateur au premier login (email, nom).
- **Session unique par utilisateur** (Android *ou* Web, jamais les deux en simultané).
- À chaque nouvelle connexion, l'ancien token est invalidé et l'ancien appareil reçoit une **notification explicite** : *"Votre session a été fermée car vous vous êtes connecté ailleurs."* **(v2.0)** Poussée en temps réel par WebSocket plutôt que récupérée par sondage — voir Module 9 et section 12.10.
- Déconnexion manuelle. **(v2.1)** Déplacée de la barre de navigation vers la page de profil (Module 10), avec le nom affiché de l'utilisateur — la barre de navigation reste ainsi légère sur mobile.

**Points d'attention techniques :**
- Le token de session doit être vérifié à chaque appel API sensible (pas seulement au login), pour détecter une invalidation à mi-session.
- La notification de kick-out doit être envoyée *avant* l'invalidation effective côté serveur pour garantir sa livraison même si l'ancien appareil perd immédiatement l'accès à l'API.
- **(v2.1)** La vérification du ID token Google doit systématiquement contrôler le claim `email_verified` en plus de la validité de la signature — un compte Google avec une adresse non vérifiée ne doit pas pouvoir créer de session.

**Données manipulées :** `users` (avec `created_at` depuis la v2.0), `sessions`

---

### Module 2 — Ingestion & Structuration des épreuves (back-office)

C'est le module le plus critique pour la qualité du produit. Il transforme un PDF hétérogène (dissertation, maths, éducation civique...) en contenu structuré exploitable par le lecteur ET par l'assistant IA, **sans travail manuel laborieux répété**, en un traitement one-shot par épreuve (coût fixe, pas récurrent).

**Pipeline d'ingestion :**

1. **Extraction du texte brut**
   - PDF natif (texte sélectionnable) → extraction directe (ex. PyMuPDF).
   - PDF scanné (image) → OCR (Tesseract en priorité, gratuit ; recours à un OCR cloud seulement si qualité insuffisante).

2. **Gestion des éléments non-textuels (images)**
   - Figures, schémas, graphiques → **implémenté en v2.0** comme upload manuel depuis le back-office plutôt que comme extraction PDF automatique (qui reste à construire, voir Module 2 — 1ère moitié non implémentée). L'admin uploade l'image (PNG/JPEG/WebP/GIF/SVG, 5 Mo max) sur l'épreuve en cours d'édition ; le fichier est stocké sous `backend/data/uploads/<epreuve_id>/` et servi via `/media/<epreuve_id>/<fichier>` ; un bouton "Insérer" ajoute automatiquement la balise `![légende](url)` dans le Markdown à l'endroit voulu.

3. **Structuration assistée par LLM (traitement unique par épreuve)**
   - Le texte brut extrait est envoyé une seule fois à un LLM avec une consigne de structuration : identifier les parties, numéros de question, énoncés, barème (si présent), et produire un **Markdown structuré** avec des ancres identifiables (ex. `{#partie-A-q3}`), formules mathématiques en LaTeX (`$...$`), tableaux en Markdown, et désormais des images (`![légende](url)`).
   - Ce traitement est un **coût fixe unique par épreuve** au moment de l'ingestion — pas un coût récurrent par consultation utilisateur, ce qui le rend budgétairement acceptable même à volume important.
   - **Non implémenté en v2.0** : cette étape d'automatisation LLM reste à construire ; le prototype actuel s'appuie sur une saisie/collage manuel du Markdown par l'admin (voir Module 8).

4. **Révision humaine (back-office admin)**
   - Vu la variabilité de qualité des sources (notamment celles glanées sur Telegram/sites tiers), une interface d'administration simple doit permettre de relire et corriger le Markdown généré avant publication (aperçu rendu + édition directe). **Implémenté en v2.0** : bascule Texte/Rendu dans le formulaire admin, plus un rappel du format attendu affiché directement dans l'interface.
   - Une épreuve n'est publiée qu'après validation admin (statut `brouillon`/`à réviser` → `publié`).

5. **Association des assets et métadonnées**
   - Chaque épreuve reçoit ses métadonnées de classement (examen, filière, matière, année, session, type sujet/corrigé) et ses images jointes (table `epreuve_assets`, voir section 5).

**Format de sortie type (exemple simplifié, avec image) :**

```markdown
# Épreuve de Mathématiques — Bac D — Session 2023

## Partie A {#partie-A}

### Question 1 {#partie-A-q1}
Soit $f(x) = x^2 - 3x + 2$. Déterminer les racines de $f$.

![Courbe représentative de f](/media/sujet_maths_bacD_2023/a1b2c3.png)

### Question 2 {#partie-A-q2}
...
```

**Points d'attention techniques :**
- Ce module est un outil **interne** (back-office), pas exposé à l'utilisateur final.
- Prévoir une file de traitement asynchrone (l'ingestion d'une épreuve peut prendre du temps) avec statut visible pour l'admin (`en cours`, `à réviser`, `publié`, `erreur`).
- Les formules mathématiques (LaTeX) doivent être rendues côté client avec une librairie type KaTeX.
- Les images uploadées sont servies telles quelles (pas de redimensionnement/compression automatique en v2.0) — à surveiller si des admins uploadent des fichiers volumineux ; la limite de 5 Mo par fichier est un garde-fou minimal.

**Exemples fournis pour le prototype :** quatre fichiers illustrant le format cible ont été préparés (dossier `exemples-epreuves/`) pour couvrir la diversité de formats identifiée : `sujet_maths_bacD_2023.md` + `corrige_maths_bacD_2023.md` (questions numérotées avec formules LaTeX, montrant le lien sujet↔corrigé par ancre `{#id}`), `sujet_histoire_bacD_2023.md` (dissertation en texte long, sans découpage fin), et `sujet_education_civique_bacA_2023.md` (mix de questions courtes et d'étude de cas). Ces fichiers peuvent être utilisés tels quels pour peupler le catalogue du prototype et tester le rendu du lecteur (Module 4) et le comportement de l'assistant IA (Module 5) sur des structures différentes.

**Données manipulées :** `epreuves`, `epreuve_contenu` (Markdown structuré), `assets`

---

### Module 3 — Catalogue & Classification

**Fonctionnalités :**
- Navigation par filtres combinables : examen (Bac) → filière (C/D/E/A...) → matière → année/session.
- Recherche texte (titre de matière, année), **(v2.3) insensible à la casse ET aux accents** ("education" trouve "Éducation") — voir section 15.6 pour le bug initial et sa cause.
- Affichage d'un statut clair par épreuve, **(v2.3) sur trois valeurs** : verrouillée ("Payant"), déjà débloquée par un abonnement actif ("Ouvert", nouveau), ou gratuite ("Gratuit"). Filtre "Accès" du catalogue mis à jour en conséquence (voir Module 6).
- **(v2.3) Pagination** (24 épreuves par page, bouton "Voir plus") plutôt qu'un chargement complet du catalogue en un seul appel — nécessaire pour rester performant à mesure que le catalogue grossit.

**Données manipulées :** `epreuves` (lecture)

---

### Module 4 — Lecteur sécurisé (Viewer)

**Fonctionnalités :**
- Rendu du contenu structuré (Markdown + LaTeX + tableaux + images) — **pas d'affichage du PDF brut**.
- Sélection/surlignage de texte par l'utilisateur, servant de déclencheur de contexte pour l'assistant IA. **(v2.3) Comportement différencié selon l'état du panneau assistant** : panneau fermé → le bouton flottant ("Demander à l'assistant") ouvre une nouvelle discussion sur ce passage ; panneau déjà ouvert → le même bouton devient "Copier dans le chat" et colle le texte dans le champ de saisie de la discussion en cours, sans jamais modifier le contexte déjà associé à cette discussion.
- **Filigrane dynamique** superposé (email ou identifiant de l'utilisateur, semi-transparent, répété sur la page) — dissuasion et traçabilité en cas de fuite.
- Protection anti-capture :
  - **Android** : `FLAG_SECURE` (bloque capture d'écran et enregistrement).
  - **Web** : aucun blocage natif possible (limite du navigateur) — le filigrane dynamique reste la seule protection réelle, à assumer comme telle.
- Désactivation de la copie de texte via le presse-papier système (le surlignage sert uniquement à définir le contexte transmis à l'IA, pas à copier le texte). **(v2.3) Bug corrigé** : une implémentation antérieure utilisait `user-select: none`, qui empêche la SÉLECTION elle-même (pas seulement la copie), rendant de fait le déclenchement de l'assistant par sélection impossible — contraire à l'intention déjà décrite ci-dessus. Corrigé via un blocage ciblé de l'évènement `copy` uniquement, laissant la sélection pleinement fonctionnelle.

**Points d'attention techniques :**
- Le filigrane doit être re-rendu dynamiquement (pas une image statique superposée facilement recadrable) et inclure des données identifiantes non triviales à retirer (email + date/heure de consultation).

**Données manipulées :** `epreuve_contenu` (lecture, déchiffrement à la volée)

---

### Module 5 — Assistant IA contextuel

**Fonctionnalités :**
- Bouton flottant visible sur l'épreuve/corrigé en cours de lecture, déclenché par la sélection d'un passage → ouvre une discussion avec ce passage pré-chargé comme contexte.
- **(v2.0)** Un second bouton, **toujours visible** (bas droite, libellé fixe "Assistant"), permet d'ouvrir l'assistant **sans sélection préalable** : il rouvre la discussion en cours s'il y en a une, ou en démarre une nouvelle sur l'épreuve entière (contexte = contenu intégral tronqué au garde-fou de longueur).
- **(v2.0)** L'assistant supporte **plusieurs discussions simultanées par épreuve** (onglets), chacune avec son propre contexte (un passage précis, ou l'épreuve entière) et son propre historique de messages — jusqu'à **5 discussions maximum par épreuve** (configurable, valeur exposée publiquement via `GET /api/config`). Chaque discussion est **fermable individuellement** (pour ne pas accumuler une longue liste d'onglets), et l'ajout d'une nouvelle discussion reste accessible en permanence (bouton "+ Nouvelle" fixe, indépendant du défilement horizontal des onglets).
- **(v2.0)** Les réponses de l'assistant (et les questions de l'élève) sont affichées en **rendu riche** (gras, listes, formules LaTeX) plutôt qu'en texte brut, via le même moteur de rendu Markdown que le lecteur.
- **(v2.0)** Les discussions sont **persistées côté serveur** (table `ai_conversations`) : elles survivent à un rechargement de page ou à une navigation ailleurs puis un retour sur l'épreuve — ce n'était pas le cas dans la version initiale du prototype (état uniquement en mémoire du navigateur).
- **(v2.3)** Les réponses sont désormais **transmises en flux (streaming)**, activé par défaut : le texte s'affiche au fur et à mesure de sa génération plutôt qu'après une attente silencieuse suivie d'un bloc complet. Voir section 15.3.
- **(v2.3)** Si le passage sélectionné contient une image (`![légende](url)`), elle est transmise en pièce jointe au fournisseur (Gemini, multimodal) plutôt qu'ignorée. Voir section 15.4.
- **(v2.3)** Le panneau peut s'afficher en **vue plein écran centrée** (bouton dédié dans son en-tête), en plus de la disposition latérale (bureau) et modale (mobile).
- L'assistant répond en s'appuyant sur : (a) le passage sélectionné ou l'épreuve entière selon le mode choisi, (b) le contexte de l'épreuve (matière, filière, année) pour calibrer le niveau de réponse.

**Comportement hors-ligne :**
- Si aucune connexion n'est disponible, l'assistant affiche un message clair : *"L'assistant a besoin d'une connexion internet. Reconnectez-vous pour poser votre question."* — pas de mise en file d'attente automatique au MVP (complexité non justifiée à ce stade).

**Points d'attention techniques :**
- Coût maîtrisé car le contexte transmis est du **texte structuré** (extrait du Markdown), jamais une image de page — économie significative par rapport à un envoi d'image à chaque question.
- Prévoir une limite de longueur de contexte transmis ; relevée en v2.0 à 4000 caractères côté serveur pour accommoder le mode "épreuve entière" tout en restant maîtrisée.
- **Choix du LLM (décision) : Gemini Flash en fournisseur primaire, Groq (modèles Llama) en repli automatique.** Justification et chiffres détaillés en section 10.2. Architecture multi-fournisseur avec bascule automatique, cohérente avec le pattern déjà implémenté dans JARVIS (multi-LLM provider support).
- **Point d'attention critique : les quotas gratuits sont partagés par l'ensemble des utilisateurs de l'application, pas alloués par utilisateur.** Un plafond de ~1500 requêtes/jour (Gemini) n'est pas "1500 par élève" mais "1500 pour toute l'app". Prévoir un compteur d'usage quotidien avec bascule automatique vers Groq quand le quota Gemini est atteint, et une alerte admin quand les deux quotas gratuits combinés approchent de la saturation (signal qu'il faut budgéter un passage au payant).
- **(v2.0)** La bascule Gemini → Groq → mode démo, auparavant un `except Exception: pass` totalement silencieux, journalise désormais chaque échec (voir section 12.1 — Journalisation).

**Données manipulées :** `ai_conversations` (persistée depuis la v2.0, y compris `messages_json` et un plafond applicatif de 5 par couple utilisateur/épreuve)

---

### Module 6 — Abonnements & Souscription

**Modèle retenu : portée par filtres avec jokers (wildcards)**, plutôt qu'une hiérarchie stricte à niveaux fixes — car matière et année sont deux axes indépendants, pas des niveaux d'un même arbre.

**Structure d'une souscription :**

```json
{
  "examen": "BAC",
  "filiere": "D",
  "matiere": "MATHS",        // ou "ALL"
  "annee": "2024",           // ou "ALL"
  "epreuve_id": null,        // renseigné uniquement pour un abonnement à une épreuve unique
  "start_date": "...",
  "end_date": "...",
  "statut": "active"
}
```

**Règle de vérification d'accès :** au moment d'ouvrir une épreuve, le système cherche si une souscription active de l'utilisateur "couvre" les attributs de l'épreuve (correspondance exacte ou joker `ALL`). Un abonnement à portée large couvre automatiquement tout ce qui est en dessous, sans duplication de logique. **(v2.0)** Un corrigé n'a pas de droits d'accès propres : la vérification se fait toujours sur le **sujet** auquel il est attaché (binôme inséparable, voir Module 2 bis) — s'abonner à une épreuve précise débloque donc automatiquement son corrigé s'il existe.

**(v2.3) Statut d'accès affiché — trois valeurs :** le catalogue (Module 3) distingue désormais visuellement trois statuts par épreuve, pas seulement deux : **Gratuit** (champ `gratuit=true`), **Ouvert** (payante, mais déjà couverte par un abonnement actif de l'utilisateur connecté — cadenas ouvert, teinte verte), et **Payant** (aucun accès actuellement). "Ouvert" est un statut purement calculé à l'affichage (à partir des abonnements de l'utilisateur), pas un champ stocké en base ; une épreuve "ouverte" se comporte comme une épreuve gratuite pour la navigation (accès direct au lecteur) et pour le filtre "Accès" du catalogue (nouvelle option, en plus de Tous/Gratuit/Payant). Voir section 15.5.

**Page de souscription centralisée — révisée en v2.0 :**
- **(v2.0) Le TYPE D'ABONNEMENT (portée) est choisi en premier**, la filière (et le cas échéant matière/année) en découlent ensuite — l'ordre inverse (filière d'abord) était jugé peu intuitif à l'usage.
- Cinq portées désormais disponibles (la 2ᵉ est nouvelle en v2.0) :
  1. **Épreuve unique** — sélection dans une liste recherchable de toutes les épreuves publiées (au lieu de choisir une filière puis de filtrer) ; la filière est déduite automatiquement de l'épreuve choisie.
  2. **Une matière, une année précise** *(nouveau, v2.0)* — comble un trou du modèle initial : couvre toutes les épreuves d'une matière ET d'une année données (utile dès qu'il existe plusieurs épreuves pour le même couple matière/année, par exemple une fois les séquences ajoutées au catalogue), sans payer le plein tarif "toutes années".
  3. Matière (toutes années)
  4. Année/session (toutes matières)
  5. Filière complète (tout)
- **(v2.0) Quantité d'épreuves incluses affichée avant achat**, à côté du prix, pour chaque portée choisie (endpoint dédié `GET /api/epreuves/count`) — l'utilisateur ne voit plus seulement un prix, mais ce qu'il obtient concrètement en retour.
- **(v2.1) Préremplissage depuis le catalogue** : cliquer sur une épreuve verrouillée redirige vers la page d'abonnement avec la portée "Épreuve précise" et cette épreuve déjà sélectionnées (transmis par paramètre d'URL), au lieu de renvoyer vers un formulaire vide que l'utilisateur devait reremplir.
- **(v2.1) Récapitulatif détaillé avant le choix du moyen de paiement** : une fois la sélection complète, un encart affiche la filière, la matière et/ou l'année concernées, le nombre exact d'épreuves couvertes, et la durée de validité — positionné explicitement **avant** le champ "Moyen de paiement" pour que la décision de payer soit prise en toute connaissance de cause.
- Le prix s'ajuste dynamiquement selon la portée choisie.
- Durée fixe : **1 an** pour toutes les formules.

**Grille tarifaire (en FCFA, mise à jour v2.0) :**

| Portée | Prix indicatif | Repère de comparaison |
|---|---|---|
| Épreuve unique (1 sujet + corrigé) | **300 – 500 FCFA** | Prix "impulsif", proche d'un petit crédit de communication |
| Matière, année précise *(nouveau)* | **700 – 900 FCFA / an** | Entre l'épreuve unique et l'abonnement matière complet |
| Matière (toutes années, une filière) | **1 500 – 2 500 FCFA / an** | Moins cher qu'un manuel scolaire d'occasion |
| Année/session complète (toutes matières, une filière) | **3 000 – 4 000 FCFA / an** | Moins de 30% des frais d'inscription à l'examen (12 000 FCFA à l'OBC en 2026) |
| Filière complète (tout) | **5 000 – 7 000 FCFA / an** | Moins de 60% des frais d'inscription à l'examen |

*Ces montants sont des points de départ à valider par un test rapide auprès d'élèves réels (sondage informel ou A/B test au lancement), pas des tarifs figés.* Le repère utilisé : les frais d'inscription au Bac s'élèvent à 12 000 FCFA en 2026, ce qui donne un ordre de grandeur de ce qu'une famille est déjà disposée à payer pour l'examen — l'abonnement le plus complet doit rester nettement en dessous.

**Point de vigilance concurrentiel :** plusieurs sites (orniformation.com, PDF partagés sur Telegram) et applications régionales (ex. Kalanso, disponible pour plusieurs pays africains francophones) proposent déjà des sujets d'examens **gratuitement**, avec un niveau de qualité et d'organisation variable. Cela signifie que **le sujet brut seul n'est pas un argument de vente suffisant** — la valeur ajoutée payante doit clairement reposer sur : la fiabilité et la qualité vérifiée des corrigés, l'assistant IA contextuel, et l'organisation/praticité de l'application (recherche, offline, absence de PDF parasites/publicité).

**Contenu gratuit de découverte (décision : oui) :**
- Une épreuve complète (sujet + corrigé) offerte par filière, choisie parmi les plus consultées, sert de vitrine pour convertir un visiteur en abonné.
- Cette épreuve gratuite doit être traitée avec le même niveau de qualité que le contenu payant (même pipeline d'ingestion, même révision) — c'est la première impression du produit.
- Techniquement : un simple champ `gratuit: true` sur l'épreuve, contournant la vérification d'accès du Module 6 (voir logique en section 11.1).

**Données manipulées :** `subscriptions`

---

### Module 7 — Paiement

**Décision : Notch Pay en solution primaire, Monetbil en solution de repli.** Justification complète en section 10.1.

**Fonctionnalités :**
- Intégration de Notch Pay, gérant Orange Money et MTN MoMo via une seule API, sans frais fixe ni engagement.
- Flux : création d'une intention de paiement liée à une souscription en attente → redirection/USSD vers l'agrégateur → réception du webhook de confirmation.

**Gestion des états (critique) :**
- `payments.statut` : `pending` → `confirmed` | `failed`.
- La **souscription ne devient active qu'à confirmation du paiement**, jamais à l'initiation.
- **Idempotence des webhooks obligatoire** : l'agrégateur peut notifier plusieurs fois le même événement. Chaque notification doit être déduplique via une clé unique (référence de transaction de l'agrégateur), pour éviter une double activation ou un double traitement.

**Données manipulées :** `payments`, `subscriptions` (mise à jour de statut)

---

### Module 8 — Back-office Administrateur

**Fonctionnalités :**
- Upload de PDF sources → déclenchement du pipeline d'ingestion (Module 2). *(Toujours non implémenté en v2.0 — l'admin saisit/colle directement le Markdown structuré, voir Module 2.)*
- Interface de révision du Markdown généré avant publication, avec **(v2.0) bascule Texte / Rendu** pour prévisualiser sans quitter le formulaire, et un **rappel du format attendu** affiché directement dans l'interface (titres/ancres, LaTeX, tableaux, images).
- **(v2.0) Upload et gestion des images jointes** à une épreuve (voir Module 2) : ajout, aperçu miniature, insertion en un clic de la balise Markdown correspondante, suppression.
- **(v2.3) Gestion fine des images par vignette** : bouton "×" dédié (retire le fichier ET la balise Markdown correspondante, quel que soit le texte de légende) et bouton "+" dédié (réinsère la balise sans re-uploader, utile si elle a été retirée manuellement du texte). Corrige aussi un bug où les vignettes elles-mêmes ne s'affichaient pas (URL relative résolue contre la mauvaise origine en développement) et où la bascule "Rendu" n'appelait en réalité jamais le moteur de rendu Markdown.
- **(v2.3) Recherche et pagination de la liste des épreuves** : la liste latérale, limitée par défaut (30 épreuves les plus récentes) et filtrable par une barre de recherche (insensible à la casse ET aux accents), reste utilisable même avec un catalogue de plusieurs centaines d'épreuves — la carte de l'épreuve en cours d'édition reste visuellement mise en évidence.
- **(v2.3) Verrou de session admin persisté en base** (table `admin_lock`, une seule ligne), plutôt qu'en mémoire comme en v2.2 : un redémarrage du backend ne libère plus silencieusement l'accès administrateur — seules l'expiration par inactivité (30 min) ou une déconnexion explicite le font. Voir section 15.2.
- Gestion du catalogue (métadonnées, publication/dépublication).
- **(v2.0) Règle du binôme sujet/corrigé appliquée dans le formulaire** : créer un corrigé impose de choisir son sujet dans une liste déroulante recherchable (impossible d'enregistrer un corrigé sans sujet valide) ; supprimer un sujet supprime son corrigé en cascade, avec confirmation explicite.
- Suivi des paiements et abonnements (support utilisateur).
- Tableau de bord basique (nombre d'utilisateurs, abonnements actifs, revenu total, épreuves par statut).
- **(v2.0) Retour d'erreur explicite** sur toute action (création, édition, publication, upload, suppression) — un point de fragilité identifié lors des tests : une erreur silencieuse côté interface (bien que le backend fonctionne correctement) donnait l'impression que des actions comme cocher "gratuit" ne s'enregistraient pas. **(v2.3)** Ces retours (succès comme échecs) sont désormais des notifications éphémères ("toast", haut-droite de l'écran) plutôt que du texte affiché en haut du formulaire, potentiellement hors champ de vision après une action réalisée plus bas dans une longue page — même traitement appliqué aux connexions/déconnexions.
- **(v2.3) Formulaires réels** (`<form>`) pour la connexion admin et l'édition d'épreuve : la touche Entrée soumet désormais correctement (bug corrigé — l'absence de balise `<form>` empêchait ce raccourci standard de fonctionner).

**Données manipulées :** l'ensemble des entités, en lecture/écriture administrative, plus `epreuve_assets` (images).

---

### Module 9 — Notifications

**Fonctionnalités :**
- Notification de kick-out de session (Module 1) — **(v2.0) poussée en temps réel par WebSocket** plutôt que récupérée par sondage périodique (voir section 12.10 pour le détail de ce changement).
- Notification de confirmation de paiement.
- Notification d'expiration prochaine d'abonnement (rappel avant la fin des 12 mois).

**Données manipulées :** un registre en mémoire des connexions WebSocket actives (une par utilisateur) sert de relais pour le kick-out temps réel ; les autres notifications resteraient, en production, portées par Firebase Cloud Messaging (mobile) en complément du WebSocket (web).

---

### Module 10 — Profil utilisateur & personnalisation *(v2.0, enrichi v2.1)*

**Fonctionnalités :**
- Page de profil : email, nom, date d'inscription, total dépensé, et **bouton de déconnexion** (déplacé ici depuis la barre de navigation en v2.1, avec le nom affiché de l'utilisateur — la nav reste ainsi compacte, y compris sur mobile).
- **(v2.1) Chaque abonnement actif est désormais décrit en détail** : portée exacte (libellé lisible, ex. "Matière, année précise"), filière/matière/année concernées, le nom de l'épreuve précise le cas échéant, le **nombre d'épreuves couvertes** (même calcul que le récapitulatif d'abonnement, Module 6), la date de souscription et la date d'expiration — plus seulement la date d'expiration seule comme en v2.0.
- **(v2.1) Annulation d'abonnement** : chaque abonnement actif dispose d'un bouton "Annuler", avec confirmation, qui révoque immédiatement l'accès (pas de remboursement au prorata dans ce prototype — à traiter lors d'une vraie intégration paiement).
- **Historique de consultation** : les 10 dernières épreuves consultées par l'utilisateur, les plus récentes en premier, affichées en tête du catalogue pour un accès rapide.
- **Discussions persistées par épreuve** (voir Module 5) — une forme de personnalisation à part entière, puisque l'élève retrouve ses questions précédentes en revenant sur une épreuve.
- Navigation : bouton "retour" disponible sur toutes les pages côté élève (absent du back-office admin, qui a son propre en-tête).

**Points d'attention techniques :**
- L'historique est stocké comme une ligne par couple (utilisateur, épreuve), avec horodatage mis à jour à chaque consultation plutôt qu'une nouvelle ligne à chaque fois — évite une croissance illimitée de la table pour un usage répété des mêmes épreuves.
- Le plafond de 10 est appliqué à la lecture (tri par date décroissante, `LIMIT 10`), pas par suppression physique des entrées plus anciennes.
- L'annulation change le statut de la souscription à `annulee` (elle n'est jamais supprimée physiquement) — préserve l'historique des paiements associés pour le total dépensé affiché, qui reste donc exact même après annulation.

**Données manipulées :** `consultations`, ainsi que `users.created_at` (ajouté en v2.0 pour dater l'inscription) et `subscriptions`/`payments` en lecture (et désormais en écriture pour l'annulation) pour l'agrégation du profil.

---

## 5. Modèle de données (schéma complet, révisé v2.2)

```
users
  id, google_id, email, nom, photo_url,
  consent_given_at, consent_version, created_at

sessions
  user_id (clé, une seule session active), token, platform[android|web], issued_at

epreuves                                              -- FUSIONNÉ v2.2 (sujet + corrigé)
  id, examen[BAC], matiere, annee, session,
  duree, coefficient, gratuit, statut[brouillon|a_reviser|publie],
  contenu_markdown (sujet, obligatoire),
  corrige_markdown (corrigé, optionnel — NULL si pas encore rédigé),
  created_at, updated_at
  -- Le champ `filiere` unique et le lien `epreuve_liee` du schéma v2.1
  -- ont disparu : une épreuve n'est plus rattachée à UNE filière mais à
  -- PLUSIEURS (voir epreuve_filieres), et le corrigé n'est plus une
  -- ligne séparée mais un champ de la même ligne (voir section 14.3).
  -- Le statut d'accès "Ouvert" (v2.3, voir section 15.5) N'EST PAS un
  -- champ ici : c'est une valeur calculée à l'affichage (frontend), à
  -- partir de `gratuit` et des `subscriptions` actives de l'utilisateur
  -- courant, jamais persistée.

epreuve_filieres                                      -- nouveau v2.2 (Point 3, many-to-many)
  id, epreuve_id (FK -> epreuves.id), filiere
  -- une ligne par (épreuve, filière) ; une épreuve de Mathématiques
  -- commune aux séries C/D/E aura donc 3 lignes ici.

epreuve_assets
  id, epreuve_id (FK -> epreuves.id), cible[sujet|corrige],   -- `cible` nouveau v2.2
  filename, url, uploaded_at
  -- `cible` distingue si l'image illustre le sujet ou le corrigé,
  -- puisque les deux vivent maintenant dans la même épreuve.

subscriptions
  id, user_id, examen, filiere,
  matiere[valeur|ALL], annee[valeur|ALL], epreuve_id (nullable),
  start_date, end_date, statut[active|expiree|annulee]
  -- `filiere` reste ici une valeur UNIQUE (une souscription cible une
  -- filière précise) ; la couverture d'une épreuve multi-filières est
  -- vérifiée par appartenance : `sub.filiere` doit figurer dans
  -- l'ensemble des filières de l'épreuve (epreuve_filieres), pas par
  -- égalité stricte comme avant le passage au multi-filières.

payments
  id, user_id, subscription_id, provider[orange|mtn],
  montant, reference_agregateur (unique, pour idempotence),
  statut[pending|confirmed|failed], created_at, confirmed_at

offline_keys                                           -- prévu, non implémenté (voir section 7)
  id, user_id, epreuve_id, cle_chiffree,
  issued_at, expires_at

ai_conversations
  id, user_id, epreuve_id, label, contexte,
  messages_json, created_at, updated_at
  -- plafond applicatif : 5 conversations actives max par (user_id, epreuve_id)

consultations
  id, user_id, epreuve_id, consulted_at
  -- une ligne par couple (user, épreuve), mise à jour à chaque visite ;
  -- l'historique affiché est un LIMIT 10 trié par consulted_at décroissant

admin_events
  id, epreuve_id, action[created|updated|published|unpublished|deleted|image_uploaded_sujet|image_uploaded_corrige|...], created_at
```

**État admin (Point 9, v2.2, révisé v2.3) :** une table dédiée `admin_lock`
(une seule ligne, id fixe `"singleton"` — email, jeton de session,
horodatages `since`/`last_activity`) retient la session admin active.
Persisté en base depuis la v2.3 (auparavant un simple registre en
mémoire, v2.2) : un redémarrage du backend ne libère plus l'accès
silencieusement — voir section 15.2.

*Note de cohérence :* le schéma v1.0 listait des tables `epreuve_contenu`
et `assets` séparées de `epreuves`, puis la v2.0 les a fusionnées en une
table `epreuves` unique par sujet/corrigé avec un lien `epreuve_liee`. La
v2.2 va plus loin : **il n'y a plus qu'une ligne par épreuve, point final**
— le corrigé est un champ, pas une ligne liée — ce qui rend structurellement
impossible d'avoir un corrigé sans sujet (au lieu d'être une règle
applicative vérifiée à chaque écriture comme en v2.0/2.1).

---

## 6. Sécurité & confidentialité

- **Chiffrement** du contenu structuré au repos (Markdown + assets), déchiffré uniquement côté client au moment de l'affichage. *(Non chiffré dans le prototype actuel — stockage en clair en base ; à traiter avant tout déploiement au-delà d'un usage de démonstration.)*
- **Filigrane dynamique** sur tout contenu affiché (identifiant utilisateur + horodatage). **(v2.0)** Corrigé pour couvrir toute la hauteur du contenu (motif SVG répété automatiquement) plutôt qu'une zone de taille fixe qui ne couvrait que le haut d'une épreuve longue.
- **FLAG_SECURE** sur Android pour bloquer capture d'écran et enregistrement (limite native web assumée et compensée par le filigrane).
- **Consentement explicite** à la politique de confidentialité, tracé (`consent_given_at`, `consent_version`) conformément aux obligations camerounaises en matière de données personnelles (loi n°2010/012, tutelle ANTIC).
- Droit à la suppression de compte (effacement des données personnelles sur demande).
- Aucune donnée bancaire stockée côté application — délégation complète à l'agrégateur de paiement.
- **Journalisation applicative (nouveau, v2.0)** : logs rotatifs (5 Mo × 5 fichiers) séparant le journal général (`app.log`) et un journal dédié aux erreurs/avertissements (`errors.log`), plus un gestionnaire d'exceptions global qui garantit qu'aucune erreur non gérée ne reste silencieuse — y compris les échecs de bascule entre fournisseurs LLM et les erreurs de validation de requête (422), auparavant invisibles en dehors de la réponse HTTP éphémère renvoyée au client. Détail en section 12.1.

---

## 7. Gestion du mode hors-ligne

**Solution retenue : clé de déchiffrement locale à durée de vie courte, renouvelée automatiquement.**

- Lors de la synchronisation en ligne, le contenu structuré et chiffré des épreuves souscrites est mis en cache localement (chiffré sur le disque de l'appareil).
- Une **clé de déchiffrement à validité limitée** (ex. 7 jours) est délivrée en parallèle, permettant la lecture offline pendant cette fenêtre.
- À chaque reconnexion, l'application vérifie si l'abonnement est toujours actif et **renouvelle la clé** si c'est le cas.
- Si l'appareil reste hors-ligne au-delà de la durée de validité de la clé, le contenu redevient illisible jusqu'à la prochaine connexion — ce qui empêche un accès permanent après expiration d'un abonnement tout en préservant un usage offline réel de plusieurs jours.
- Cette approche s'appuie sur des mécanismes déjà maîtrisés dans les projets précédents (Firebase offline persistence), simplifiant l'implémentation.

---

## 8. Roadmap de développement vers le premier prototype

| Phase | Contenu | Sortie |
|---|---|---|
| **Phase 0 — Fondations** | Setup Firebase, Auth Google, structure Capacitor Android+Web, modèle de données initial | Squelette applicatif fonctionnel, login opérationnel |
| **Phase 1 — Ingestion** | Pipeline d'extraction PDF → Markdown structuré + interface admin de révision | 10-20 épreuves pilotes publiées, couvrant maths/dissertation/éducation civique pour valider la robustesse du pipeline sur des formats variés |
| **Phase 2 — Catalogue & Lecteur** | Navigation filtrée, lecteur sécurisé avec rendu Markdown/LaTeX, filigrane, FLAG_SECURE | Un utilisateur peut parcourir et lire une épreuve publiée de bout en bout |
| **Phase 3 — Abonnement & Paiement** | Modèle wildcard, page de souscription centralisée, intégration agrégateur + webhooks idempotents | Un utilisateur peut souscrire et payer, l'accès se débloque correctement |
| **Phase 4 — Assistant IA** | Sélection de texte → appel LLM contextualisé, gestion état hors-ligne | Un utilisateur peut poser une question sur un passage sélectionné et recevoir une réponse |
| **Phase 5 — Session unique & Offline** | Kick-out de session avec notification, clé de déchiffrement à durée limitée | Comportement de session et d'offline conforme aux spécifications |
| **Phase 6 — Durcissement & tests** | Tests sur connexion instable/faible, tests de charge basique, revue sécurité | Premier prototype fonctionnel prêt à démonstration |

---

## 9. Risques identifiés & mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Droits sur le contenu republié (sourcing Telegram/tiers) | Juridique, potentiellement bloquant à terme | À surveiller particulièrement sur les corrigés (plus susceptibles d'être une œuvre identifiable) ; envisager à moyen terme une production propre de corrigés par des enseignants rémunérés |
| Qualité variable des PDF sources | Qualité produit | Étape de révision humaine obligatoire avant publication (Module 2) |
| Absence de blocage anti-capture sur Web | Fuite de contenu | Filigrane dynamique comme mitigation principale, assumé comme non-bloquant à 100% |
| Partage de compte | Perte de revenus | Session unique stricte avec kick-out explicite (limite le partage simultané, pas le partage séquentiel — acceptable au MVP) |
| Double traitement de paiement | Facturation incorrecte | Idempotence stricte des webhooks via référence de transaction unique |
| Connexion instable des utilisateurs | Abandon utilisateur | Mode offline pensé comme fonctionnalité centrale dès le MVP, pas en option secondaire |

---

## 10. Études comparatives détaillées

### 10.1 Agrégateurs de paiement (Orange Money / MTN MoMo)

| Solution | Frais transaction | Frais fixes | Enregistrement entreprise requis | Couverture Cameroun | Remarque |
|---|---|---|---|---|---|
| **Notch Pay** ✅ **retenu** | 2% par paiement encaissé, 1% par transfert sortant | Aucun (ni installation ni mensuel) | Oui | MTN + Orange + Express Union + autres | Tarification publique, transparente, engagement zéro — idéal pour démarrer sans visibilité sur le volume |
| **Monetbil** ✅ **repli** | Non publié précisément (historiquement compétitif, ~2-3%) | Aucun frais caché annoncé | **Non — inscription non requise pour démarrer** | Solution d'origine camerounaise, très utilisée localement | Meilleure option si le statut d'entreprise n'est pas encore formalisé ; documentation en français |
| **PawaPay** | Non publié publiquement (sur devis) | Aucun sur l'offre Standard | Oui | MTN + Orange confirmés au Cameroun | Solide techniquement mais moins transparent sur les tarifs sans contact commercial |
| **CinetPay** | ~2 à 4% selon les échanges communautaires (non garanti, à négocier) | Aucun frais d'abonnement | Oui, avec documents d'identification | MTN + Orange + cartes | Tarifs non publiés en clair sur le site, nécessite un contact commercial pour un chiffrage exact |
| **FeexPay** ❌ **écarté** | — | — | — | **Ne couvre pas le Cameroun** (Bénin, Côte d'Ivoire, Sénégal, Togo, Burkina Faso, Congo) | Éliminé : absent de la liste officielle des pays couverts |

**Décision : Notch Pay comme solution primaire.** C'est la seule option de la liste avec une tarification publique, simple et sans engagement (2% par encaissement, aucun frais fixe) — un point déterminant pour un budget très faible où l'on veut payer strictement proportionnellement à l'usage réel, sans coût récurrent avant d'avoir des utilisateurs payants.

**Repli recommandé : Monetbil**, à activer en secours si l'ouverture d'un compte marchand Notch Pay bute sur l'exigence d'enregistrement d'entreprise avant que celle-ci soit formalisée — Monetbil ne demande pas cette formalité pour démarrer, ce qui peut débloquer un lancement plus rapide.

*Note : les taux exacts évoluent régulièrement ; à reconfirmer directement sur les tableaux de bord des deux solutions avant l'intégration finale, et à renégocier une fois un volume significatif atteint (les deux acteurs proposent des tarifs dégressifs sur devis).*

### 10.2 Fournisseur LLM pour l'assistant IA

| Solution | Quota gratuit | Qualité pour le français / pédagogie | Stabilité | Remarque |
|---|---|---|---|---|
| **Gemini Flash (Google)** ✅ **retenu (primaire)** | ~1 500 requêtes/jour, 15 requêtes/minute, 1M tokens/minute, sans carte bancaire, sans expiration | Très bonne — Google investit fortement le multilingue, le français est bien couvert | Élevée, quota stable et documenté officiellement | Réserve : en free tier, les prompts peuvent être utilisés par Google pour l'entraînement de ses modèles — acceptable pour des questions sur des sujets d'examen publics, à garder en tête si des données plus sensibles s'ajoutent plus tard |
| **Groq (modèles Llama open-source)** ✅ **retenu (repli)** | ~14 400 requêtes/jour, 30 requêtes/minute, 6 000 tokens/minute, sans carte bancaire | Correcte en français (Llama 3.3 70B couvre le français) mais un cran en dessous de Gemini sur la nuance pédagogique | Élevée, service tourné vers la vitesse d'inférence (réponses très rapides, un vrai plus pour un utilisateur en 3G/4G instable) | Excellent filet de sécurité : capacité quotidienne bien plus grande que Gemini, à activer automatiquement quand le quota Gemini est épuisé |
| **OpenRouter (modèles :free)** ❌ **écarté comme solution principale** | Seulement 50 à 1 000 requêtes/jour selon crédits achetés, 20 requêtes/minute | Variable — dépend du modèle actif ce jour-là | **Faible** : les modèles gratuits tournent et peuvent être retirés sans préavis | Trop instable pour une fonctionnalité cœur de produit ; utilisable en test/développement uniquement |
| **Ollama (auto-hébergé)** ⏸️ **différé** | Illimité en théorie, mais coût = infrastructure | Dépend du modèle local choisi | Dépend entièrement de la fiabilité de l'hébergement (électricité, serveur) | Non retenu au MVP : héberger soi-même un modèle capable exige un serveur avec des ressources significatives, ce qui contredit l'objectif "gratuit d'abord". À reconsidérer en phase de croissance si le volume dépasse largement les quotas gratuits combinés et rend l'auto-hébergement plus économique qu'une API payante |

**Décision : architecture à deux fournisseurs gratuits avec bascule automatique — Gemini Flash en primaire, Groq en repli.** Cette approche s'appuie sur un pattern déjà éprouvé dans JARVIS (support multi-fournisseur LLM).

**Capacité combinée estimée :** environ 1 500 (Gemini) + 14 400 (Groq) ≈ **15 900 requêtes gratuites par jour** pour l'ensemble de l'application. En estimant une moyenne de 3 questions à l'assistant par élève actif et par jour, cela couvre confortablement plusieurs milliers d'élèves actifs simultanés sans dépenser un franc en LLM — largement suffisant pour un MVP et une phase de croissance initiale. Un tableau de bord admin doit suivre la consommation quotidienne des deux quotas pour anticiper le moment où un passage au payant (ou à l'auto-hébergement) devient nécessaire.

## 11. Annexes

### 11.1 Exemple de flux de vérification d'accès à une épreuve (pseudo-code)

```python
def has_access(user_id, epreuve):
    subs = get_active_subscriptions(user_id)
    for sub in subs:
        if sub.examen == epreuve.examen and \
           sub.filiere == epreuve.filiere and \
           (sub.matiere == "ALL" or sub.matiere == epreuve.matiere) and \
           (sub.annee == "ALL" or sub.annee == epreuve.annee) and \
           (sub.epreuve_id is None or sub.epreuve_id == epreuve.id):
            return True
    return False
```

### 11.2 Décisions tranchées (voir section 10 pour le détail)

- ✅ Agrégateur de paiement : **Notch Pay** (primaire), **Monetbil** (repli).
- ✅ Fournisseur LLM : **Gemini Flash** (primaire), **Groq** (repli automatique).
- ✅ Grille tarifaire : voir Module 6, de 300 FCFA (épreuve unique) à 7 000 FCFA/an (filière complète).
- ✅ Contenu gratuit de découverte : oui, une épreuve complète offerte par filière.

### 11.3 Points encore ouverts

- Montant exact des paliers tarifaires à valider par un test terrain (sondage rapide auprès d'élèves ou A/B test au lancement) — la grille proposée est un point de départ, pas un tarif figé.
- Confirmation des taux exacts Notch Pay/Monetbil au moment de l'intégration technique (les tarifs évoluent).
- Seuil précis de bascule vers un LLM payant ou l'auto-hébergement, à définir une fois des données d'usage réelles disponibles.

---

## 12. Évolutions fonctionnelles depuis la version 1.0

Cette section documente, point par point, les évolutions apportées au prototype après la spécification initiale — pour l'essentiel des correctifs identifiés à l'usage et des fonctionnalités que la v1.0 n'avait pas encore détaillées. Chaque sous-section renvoie au(x) module(s) déjà décrit(s) plus haut, qui font foi pour le détail fonctionnel ; on ne répète ici que le **delta** par rapport à la v1.0 et sa justification.

### 12.1 Journalisation applicative

**Constat :** plusieurs erreurs (notamment la bascule silencieuse entre fournisseurs LLM en cas d'échec, et des erreurs de validation de requête) ne laissaient aucune trace exploitable — impossible de diagnostiquer un problème une fois la réponse HTTP éphémère disparue.

**Solution :** logs rotatifs fichier (5 Mo × 5 fichiers d'historique), séparant le journal général (`app.log`) des avertissements/erreurs (`errors.log`), plus un gestionnaire d'exceptions global qui journalise systématiquement toute exception non gérée — y compris, spécifiquement, les erreurs de validation (422), avec le détail du champ en cause et le corps de requête reçu, pour diagnostiquer précisément une désynchronisation entre le frontend et le backend.

### 12.2 Images jointes aux épreuves

**Constat :** certaines épreuves contiennent des figures, schémas ou graphiques qui ne peuvent pas être rendus en texte structuré seul.

**Solution :** upload d'images depuis le back-office (Module 8), stockage sur disque sous `backend/data/uploads/<epreuve_id>/`, service via une route statique dédiée, et insertion en un clic de la balise Markdown correspondante dans le contenu de l'épreuve (voir Module 2). L'extraction automatique d'images depuis un PDF source reste hors périmètre de cette version — l'upload est manuel, ce qui est cohérent avec le reste du pipeline d'ingestion actuel (également manuel, voir Module 2).

### 12.3 Ouverture de l'assistant sans sélection, discussions multiples et fermables

**Constat :** l'assistant ne pouvait être ouvert qu'en sélectionnant un passage de texte au préalable, ce qui empêchait de poser une question générale sur l'épreuve entière.

**Solution :** un second point d'entrée, toujours visible, ouvre l'assistant sans sélection (reprise de la discussion en cours, ou nouvelle discussion sur l'épreuve entière). L'assistant supporte désormais plusieurs discussions par épreuve (onglets fermables individuellement), plafonnées à 5 par épreuve pour éviter une accumulation ingérable — plafond appliqué à la fois côté serveur (rejet explicite au-delà) et côté interface (bouton désactivé). Voir Module 5.

### 12.4 Rendu riche des messages de l'assistant

**Constat :** les réponses de l'assistant, potentiellement formatées (listes, formules), s'affichaient en texte brut.

**Solution :** les messages passent désormais par le même moteur de rendu Markdown/LaTeX que le lecteur d'épreuves (variante compacte dédiée aux bulles de discussion). Voir Module 5.

### 12.5 Correction du positionnement du bouton de sélection et de la bascule sujet/corrigé

**Constat 1 :** le bouton flottant apparaissant lors d'une sélection de texte pouvait sortir du cadre visible de l'écran, le rendant impossible à cliquer.
**Cause :** l'élément était positionné en `position: fixed` (relatif à la fenêtre) mais ses coordonnées étaient calculées comme pour un élément `position: absolute` (relatif au document, en ajoutant le défilement de la page) — un décalage qui s'accumulait avec le défilement jusqu'à pousser le bouton hors champ.
**Solution :** coordonnées recalculées en viewport-relatif pur, avec un bornage explicite garantissant que le bouton reste toujours entièrement visible, y compris pour une sélection tout en haut ou tout en bas de l'écran.

**Constat 2 :** la bascule entre le sujet et son corrigé semblait lente.
**Cause :** chaque bascule ré-analysait et ré-affichait l'intégralité du Markdown/LaTeX du document ciblé, une opération coûteuse pour un contenu long.
**Solution :** le sujet et le corrigé, une fois chargés, restent tous deux montés ; seule leur visibilité bascule (CSS), éliminant le re-rendu répété.

**Constat 3 :** le filigrane ne couvrait que le haut de l'épreuve.
**Cause :** l'ancienne implémentation dessinait un nombre fixe de tuiles de texte, insuffisant pour couvrir un contenu long.
**Solution :** remplacé par un motif SVG (`<pattern>`) qui se répète automatiquement sur toute la hauteur réelle du contenu, quelle que soit sa longueur.

Voir Modules 4 et 5 pour le détail fonctionnel.

### 12.6 Filtres catalogue supplémentaires

**Ajout :** deux filtres au catalogue (Module 3) — présence ou non d'un corrigé, et accès gratuit ou payant — en complément des filtres existants (filière, matière, année), tous désormais présentés en menus déroulants avec recherche plutôt qu'en listes de puces, pour rester utilisables si le nombre de valeurs augmente fortement.

### 12.7 Refonte du modèle d'abonnement

**Constat :** la grille de portées (v1.0) ne permettait pas de cibler une matière pour une année précise sans payer le tarif "toutes les années", et n'indiquait pas à l'utilisateur ce qu'il obtenait concrètement pour son argent.

**Solution :** ajout d'une cinquième portée ("matière, année précise"), et affichage de la quantité d'épreuves incluses à côté du prix pour chaque portée, calculée en temps réel selon les filtres choisis. L'ordre de sélection a également été inversé : le type d'abonnement se choisit désormais avant la filière. Voir Module 6 pour la grille tarifaire complète mise à jour.

### 12.8 Correctif du back-office (erreur 422) et bascule texte/rendu

**Constat :** une erreur *"Input should be a valid dictionary or object to extract fields from"* apparaissait sur certaines requêtes de mise à jour d'épreuve depuis le back-office.

**Cause identifiée :** le client HTTP du frontend fusionnait incorrectement les en-têtes de requête — un appel fournissant ses propres en-têtes (comme le jeton admin) perdait silencieusement l'en-tête `Content-Type: application/json` par écrasement d'objet plutôt que fusion, ce qui pouvait perturber l'interprétation du corps de la requête côté serveur. Corrigé, et vérifié en reproduisant l'erreur exacte signalée puis en confirmant sa disparition après correctif (voir aussi 12.1 pour la journalisation qui aurait permis un diagnostic immédiat si elle avait déjà été en place).

**Ajout complémentaire :** une bascule Texte/Rendu dans le formulaire admin permet de prévisualiser le Markdown avant publication, réduisant le risque d'erreurs de synchronisation entre ce qui est saisi et ce qui sera effectivement affiché aux élèves. Voir Module 8.

### 12.9 Profil utilisateur et personnalisation

**Ajout :** une page de profil (email, nom, date d'inscription, abonnements actifs et leur date d'expiration, total dépensé), un historique des 10 dernières épreuves consultées affiché en tête du catalogue, la persistance des discussions par épreuve (voir 12.3), et un bouton de retour à la page précédente disponible partout côté élève (absent du back-office, qui a son propre en-tête). Voir Module 10 (nouveau).

### 12.10 Notifications de session en temps réel (remplacement du polling)

**Constat :** la détection de fermeture de session (kick-out, Module 1) reposait sur deux appels HTTP répétés toutes les 4 secondes (`GET /api/auth/me` et `GET /api/auth/kickout-notice/{user_id}`), générant du trafic et du bruit dans les journaux même en l'absence de tout événement.

**Solution :** une connexion WebSocket unique (`/ws/session`), ouverte après connexion, sur laquelle le serveur pousse directement la notification de kick-out au moment où elle se produit — remplaçant un sondage périodique par une notification événementielle. Le registre des connexions actives est un simple dictionnaire en mémoire (une entrée par utilisateur), suffisant pour un unique process serveur ; l'ancien mécanisme de sondage (`GET /kickout-notice`) est conservé côté API comme filet de repli mais n'est plus interrogé en continu par le frontend. Vérifié avec un client WebSocket réel simulant une seconde connexion. Voir Module 9.

*Limite connue :* pas de stratégie de reconnexion automatique en cas de coupure de la connexion WebSocket dans ce prototype — à ajouter avant un usage en production (voir section "Limitations" du README).

### 12.11 Mode clair/sombre

**Ajout :** thème clair/sombre piloté par une classe CSS sur l'élément racine, avec la préférence système du navigateur (`prefers-color-scheme`) comme valeur par défaut, et une bascule manuelle mémorisée (localStorage) qui prend le pas sur la préférence système une fois activée. Un script exécuté avant le premier rendu applique le thème correct pour éviter tout flash visuel de la mauvaise couleur au chargement. L'architecture de tokens de couleur déjà en place (variables CSS sémantiques : papier, encre, surligneur...) a permis d'implémenter les deux palettes sans modifier le code des composants individuels — seules les valeurs des tokens changent selon le thème actif.

---

## 13. Évolutions fonctionnelles — version 2.1

Cette section documente la deuxième vague de correctifs et d'ajouts, appliqués après un premier tour d'usage réel du prototype v2.0. Comme pour la section 12, seul le **delta** est détaillé ici ; les modules mis à jour plus haut font foi pour le comportement complet.

### 13.1 Correctifs de contraste en mode sombre

**Constat :** certains éléments (champs de formulaire, menus déroulants, badges sur fond surligneur) devenaient illisibles en mode sombre — texte clair sur fond resté blanc, ou texte devenu clair sur un fond jaune vif qui, lui, ne change pas de thème.

**Cause :** plusieurs composants utilisaient un fond blanc écrit en dur (`bg-white`) plutôt que le token de couleur adapté au thème (`--color-paper-raised`), qui, lui, bascule correctement entre clair et sombre. Par ailleurs, les éléments sur fond surligneur (jaune, volontairement identique dans les deux thèmes) utilisaient le token de texte principal, qui devient clair en mode sombre — combinaison illisible sur un fond qui reste clair.

**Solution :** remplacement systématique des fonds figés par les tokens adaptatifs, et introduction d'un token dédié (`--color-highlight-ink`) fixé à une teinte sombre **dans les deux thèmes**, pour tout texte posé sur le surligneur jaune. La teinte verte de validation en mode sombre a également été légèrement assombrie pour préserver un contraste suffisant avec le texte blanc des boutons de confirmation.

### 13.2 Préremplissage et clarification de la page Abonnement

**Constat 1 :** cliquer sur une épreuve verrouillée dans le catalogue renvoyait vers une page d'abonnement vide, obligeant à rechercher à nouveau l'épreuve en question.
**Solution :** l'identifiant de l'épreuve est désormais transmis à la page Abonnement, qui présélectionne automatiquement la portée "Épreuve précise" avec cette épreuve.

**Constat 2 :** le filtre "Année" du catalogue affichait "Toutes les années" par défaut, alors que la majorité des consultations concernent la session la plus récente.
**Solution :** l'année la plus récente disponible est désormais sélectionnée par défaut (l'option "Toutes les années" reste accessible en un clic).

**Constat 3 :** l'utilisateur ne voyait qu'un prix, sans description de ce qu'il obtenait concrètement.
**Solution :** un récapitulatif (filière, matière/année concernées, nombre d'épreuves couvertes, durée de validité) s'affiche désormais une fois la sélection complète, positionné **avant** le choix du moyen de paiement pour informer la décision.

Voir Module 6 pour le détail.

### 13.3 Profil enrichi, annulation d'abonnement, et repositionnement de la déconnexion

**Ajouts :** chaque abonnement du profil affiche désormais sa portée complète, le nombre d'épreuves couvertes, ses dates de souscription et d'expiration, et un bouton d'annulation immédiate (avec confirmation). Le nom affiché de l'utilisateur et le bouton de déconnexion, auparavant dans la barre de navigation sur toutes les pages, ont été déplacés vers la page de profil — une barre de navigation plus compacte, en particulier sur mobile, où l'espace horizontal est limité. Voir Module 10.

### 13.4 Curseur du champ d'upload d'images (back-office)

**Constat :** le champ de sélection de fichier pour l'upload d'images n'indiquait pas visuellement qu'il était cliquable.
**Solution :** style explicite du bouton natif du champ (curseur pointeur, fond et couleur cohérents avec le reste de l'interface). Voir Module 8.

### 13.5 Fournisseurs IA — modèles à jour et diagnostic des erreurs

**Constat :** l'assistant tombait systématiquement en mode démo, avec une erreur *"404 Not Found"* sur l'appel à Groq visible dans les journaux (le correctif du point 12.1 ayant permis de la voir).

**Diagnostic :** l'alias de modèle Gemini utilisé (`gemini-flash-latest`) s'est révélé non fiable ; Gemini échouait donc silencieusement en amont, avant même que Groq soit sollicité en repli. Le nom de modèle Groq et l'URL d'API ont été vérifiés corrects par rapport à la documentation officielle du fournisseur au moment de la correction.

**Solution :** le modèle Gemini par défaut est passé à un nom concret et à jour (`gemini-3.5-flash`), l'authentification est passée du paramètre d'URL `?key=...` (marqué obsolète par la documentation Google) à l'en-tête `x-goog-api-key` recommandé, et **les deux modèles (Gemini et Groq) sont désormais configurables par variable d'environnement** (`GEMINI_MODEL`, `GROQ_MODEL`) pour ne plus dépendre d'un nom en dur si la gamme de modèles évolue à nouveau. Surtout : toute erreur d'un fournisseur journalise désormais le **corps complet de sa réponse**, pas seulement le code HTTP — un "404" seul ne permettait pas de diagnostiquer la cause réelle, alors que le message d'erreur renvoyé par le fournisseur, lui, l'explique presque toujours. Voir Module 5.

*Point de vigilance permanent :* les fournisseurs de LLM font évoluer leur gamme de modèles fréquemment (dépréciations, renommages). La configuration par variable d'environnement introduite ici limite l'impact d'un futur changement à une simple modification de `.env`, sans toucher au code.

### 13.6 Audit d'accessibilité

**Périmètre vérifié et corrigé :**
- **HTML sémantique** : présence cohérente de `<header>`, `<nav>`, `<main>`, `<section>`/`<article>`/`<fieldset>` selon le contenu, et `<footer>`, sur toutes les pages (y compris le back-office admin, qui a sa propre structure de page).
- **Icônes** : tous les emojis utilisés comme icônes fonctionnelles (bouton assistant, fermeture, retour, avertissement, sélection de texte...) remplacés par des icônes SVG [Lucide React](https://lucide.dev), avec `aria-hidden="true"` sur les icônes décoratives et `aria-label` sur les boutons icône-seul.
- **Navigation clavier** : les menus déroulants (Combobox) sont des éléments `<button>`/`<input>` nativement focusables, se ferment à la touche Échap, et exposent les attributs ARIA de base (`aria-haspopup`, `aria-expanded`, `role="listbox"`/`"option"`).
- **Texte alternatif** : vérifié sur toutes les images (aperçus d'images uploadées dans l'admin, notamment) ; le filigrane et le logo, purement décoratifs, sont marqués `aria-hidden`.
- **Responsive** : disposition vérifiée à 375px (mobile), 768px (tablette), 1024px (desktop) et 1440px (large) ; la barre de navigation masque le nom de marque textuel et le lien "Admin" sous 640px pour éviter tout débordement horizontal sur petit écran, plutôt que de laisser le contenu déborder ou se chevaucher.
- **Cibles tactiles** : les contrôles principaux (boutons de navigation, bascule de thème, bouton assistant, boutons de formulaire, options des menus déroulants) portent une taille minimale de 44×44px, conformément aux recommandations d'accessibilité tactile mobile.

*Limite assumée :* cet audit est manuel et ciblé sur les parcours principaux, pas un test automatisé (axe-core, Lighthouse) ni une validation avec un lecteur d'écran réel — voir la table des limitations du README pour la suite à donner avant une mise en production.

### 13.7 Déploiement de test gratuit *(remplacé en v2.2, voir section 14.9)*

**Ajout initial (v2.1) :** un script `deploy.sh` déployait uniquement le frontend sur Vercel. **Cette approche a été abandonnée dès la version suivante** au profit d'un déploiement unifié — voir section 14.9 pour la solution actuelle et sa justification.

---

## 14. Évolutions fonctionnelles — version 2.2

Troisième vague de correctifs et d'ajouts, centrée sur la structure des
données, l'optimisation, et la fiabilité en usage concurrent (plusieurs
élèves, plusieurs admins potentiels).

### 14.1 Centralisation du stockage des données

**Constat :** deux dossiers nommés "data" coexistaient à des profondeurs différentes (`backend/app/data/` pour le contenu d'exemple, `backend/data/` pour les uploads et la base), source de confusion.

**Solution :** un seul dossier `backend/data/`, avec une séparation claire par nature de contenu :

```
backend/data/
  epreuves/
    sujets/*.md      Sujets d'exemple (seed)
    corriges/*.md     Corrigés d'exemple, appariés par nom de fichier
  uploads/<epreuve_id>/<sujet|corrige>/   Images uploadées
  bacprep.db          Base SQLite
```

Le format de seed a changé en conséquence : un sujet et son corrigé sont désormais deux fichiers distincts dans deux dossiers distincts, appariés par nom de fichier identique (`sujets/maths_2023.md` ↔ `corriges/maths_2023.md`) plutôt que par un identifiant croisé dans le frontmatter.

### 14.2 Épreuves multi-filières

**Constat :** le modèle ne permettait qu'une seule filière par épreuve, alors qu'un même sujet (typiquement en Mathématiques) est souvent commun à plusieurs séries (C, D, E par exemple).

**Solution :** relation many-to-many via une table de jonction `epreuve_filieres` (voir section 5). Toute la logique de vérification d'accès, de comptage et de filtrage a été adaptée pour tester une **appartenance** (la filière de l'abonnement fait-elle partie de l'ensemble des filières de l'épreuve ?) plutôt qu'une égalité stricte. Le formulaire admin accepte une liste de filières séparées par des virgules. Testé de bout en bout : une épreuve de Mathématiques marquée `[C, D, E]`, souscrite via un abonnement scopé sur la filière C, est bien accessible.

### 14.3 Fusion du sujet et du corrigé en une seule entité

**Constat :** même avec la règle d'intégrité ajoutée en v2.0 (un corrigé doit référencer un sujet existant), sujet et corrigé restaient deux lignes distinctes en base et deux sections distantes dans l'interface admin — contraire à l'esprit du binôme "inséparable" annoncé dès la v1.0, et une source de duplication d'effort à l'édition.

**Solution :** une épreuve est désormais **une seule ligne**, avec deux champs de contenu (`contenu_markdown` pour le sujet, `corrige_markdown` pour le corrigé, ce dernier pouvant être vide tant qu'il n'est pas encore rédigé) et deux ensembles d'images distingués par un champ `cible`. Le formulaire d'édition admin affiche les deux blocs de contenu l'un sous l'autre, chacun avec sa propre bascule Texte/Rendu et sa propre zone d'upload d'images. Cette fusion élimine par construction toute possibilité de corrigé orphelin (ce n'était qu'une règle vérifiée à l'écriture auparavant) et supprime le besoin d'un second appel réseau pour afficher le corrigé côté lecteur (voir aussi 14.8, performance).

### 14.4 Reconnexion WebSocket automatique

**Constat :** la connexion WebSocket utilisée pour la notification de session en temps réel (v2.0) ne se rétablissait pas après une coupure réseau — un élève avec une connexion mobile instable perdait silencieusement cette fonctionnalité pour le reste de sa session.

**Solution :** reconnexion automatique avec délai croissant (1s, 2s, 4s, 8s, plafonné à 15s), réinitialisé dès qu'une connexion réussit. La reconnexion s'arrête définitivement si l'utilisateur se déconnecte explicitement ou reçoit une notification de kick-out (plus de session à surveiller). Voir Module 9.

### 14.5 Contraste du panneau assistant en mode sombre

**Constat :** le correctif de contraste de la v2.1 n'avait traité que les éléments utilisant un fond clair figé ; le panneau assistant (Module 5), dont le fond reste volontairement sombre **dans les deux thèmes**, utilisait pour son texte le token principal de la page (`paper`) — qui, lui, bascule vers une couleur sombre en mode sombre. Résultat : texte sombre sur fond sombre, illisible, précisément dans le mode que le correctif précédent visait à réparer.

**Solution :** un token dédié (`--color-margin-text`), fixé à une teinte claire **dans les deux thèmes** et jamais redéfini dans la déclaration `.dark`, utilisé pour tout le texte à l'intérieur du panneau assistant. Ce même principe (token fixe pour une surface à fond invariant) avait déjà été appliqué en v2.1 au texte posé sur le surligneur jaune (`--color-highlight-ink`) — la même catégorie de bug se reproduisait ici sur une autre surface à fond intentionnellement invariant, et appelait la même catégorie de solution.

### 14.6 Fusion admin, en un seul formulaire (voir aussi 14.3)

Le Module 8 (back-office) reflète directement la fusion du modèle décrite en 14.3 : plus de champ "sujet auquel attacher ce corrigé" à renseigner, plus de type d'épreuve à choisir — un seul formulaire couvre l'épreuve complète.

### 14.7 Accès admin restreint et session unique

**Constat :** n'importe qui connaissant le jeton admin partagé pouvait se connecter, sans limite sur le nombre de connexions simultanées — aucune protection contre deux personnes modifiant la même épreuve en même temps sans le savoir.

**Solution :** deux mécanismes combinés :
- **Liste blanche d'emails** (`ADMIN_EMAILS`, configurable) — le jeton seul ne suffit plus, l'email utilisé doit aussi figurer dans la liste autorisée.
- **Session admin unique** : une seule connexion active à la fois, tenue en mémoire côté serveur. Une deuxième personne autorisée qui tente de se connecter reçoit un message explicite (qui est connecté, depuis quand) plutôt qu'un accès silencieusement partagé ou un refus sans explication, avec la possibilité de **forcer la prise de contrôle** si la première session a été oubliée. Une session inactive depuis plus de 30 minutes se libère automatiquement pour ne pas bloquer indéfiniment l'accès. Testé : connexion, tentative bloquée par un second email, prise de contrôle forcée réussie.

Voir Module 1 (principe similaire déjà en place côté élève) et Module 8.

### 14.8 Optimisations de performance

**Constat :** le chargement du catalogue et le rendu d'une épreuve étaient perçus comme lents.

**Solutions combinées :**
- **Élimination d'un problème N+1** : la fusion sujet/corrigé (14.3) supprime de fait la requête séparée qui vérifiait auparavant, pour chaque épreuve listée, l'existence d'un corrigé — c'est désormais un simple champ déjà chargé avec la ligne.
- **Chargement `selectin`** des filières et images d'une épreuve (une requête groupée pour l'ensemble des résultats plutôt qu'une par épreuve).
- **Compression gzip** des réponses HTTP au-delà de 1 Ko (`GZipMiddleware`) — gain net sur le contenu Markdown des épreuves longues.
- **Bascule sujet/corrigé instantanée** côté lecteur : les deux contenus arrivant désormais dans le même appel API (14.3), la bascule ne déclenche plus aucune requête réseau.
- **Mémoïsation** du nettoyage et du rendu Markdown côté frontend (`React.memo` + `useMemo`), pour ne pas retraiter un contenu inchangé à chaque nouveau rendu du composant parent.
- **Découpage de code** : l'interface admin (utilisée par une poignée de personnes, jamais les élèves) est chargée en dynamique (`React.lazy`) plutôt que d'alourdir le paquet JavaScript initial téléchargé par tout le monde.
- Voir aussi 14.10 pour les optimisations côté base de données, fichiers et appels IA, qui contribuent également à la latence perçue.

### 14.9 Déploiement unifié et gratuit (remplace la v2.1)

**Constat :** le déploiement Vercel introduit en v2.1 ne couvrait que le frontend, laissait le backend sans solution, et imposait de gérer deux plateformes séparées (avec la configuration CORS que cela implique).

**Solution :** FastAPI sert désormais directement l'application React compilée (`frontend/dist`) — toute route qui n'est ni une API (`/api/*`) ni un média (`/media/*`) renvoie `index.html`, laissant React Router gérer la navigation côté client. **Une seule application, un seul process, un seul port.** Le guide de déploiement (`DEPLOIEMENT.md`) recommande **Render** plutôt que Vercel : contrairement à ce dernier (serverless, sans état), Render exécute un process persistant, compatible avec les connexions WebSocket longue durée et un stockage qui doit survivre entre les requêtes. Un fichier `render.yaml` (Blueprint) permet un déploiement en un clic provisionnant à la fois le service web et une base PostgreSQL gratuite — utilisée plutôt que SQLite pour ce déploiement, car le disque du service web gratuit Render est éphémère (les images uploadées restent, elles, non persistantes sur cette offre — limite documentée explicitement plutôt que passée sous silence).

### 14.10 Optimisation base de données, fichiers et appels IA

**Base de données :** activation du mode **WAL** (Write-Ahead Logging) pour SQLite, qui permet aux lectures de ne pas être bloquées par une écriture en cours — un gain réel dès qu'un admin publie une épreuve pendant que des élèves consultent le catalogue. `pool_pre_ping=True` sur toute connexion (évite les erreurs sur une connexion devenue invalide, en particulier sur les bases gratuites qui coupent les connexions inactives), et un pool dimensionné explicitement pour PostgreSQL en production.

**Fichiers :** les images uploadées sont automatiquement redimensionnées (1600px de large maximum) et recompressées à l'upload, réduisant l'espace disque occupé et la bande passante nécessaire pour les servir aux élèves — avec dégradation gracieuse si la bibliothèque d'image n'est pas disponible (le fichier original est alors conservé tel quel plutôt que de faire échouer l'upload).

**Appels IA :** un sémaphore limite le nombre d'appels concurrents vers les fournisseurs LLM (Gemini/Groq, configurable via `LLM_CONCURRENCY_LIMIT`) — au-delà de la limite, les requêtes supplémentaires attendent leur tour (file d'attente naturelle) plutôt que de partir toutes en même temps et de risquer de heurter les limites de taux des offres gratuites (voir section 10.2).

### 14.11 Révélation progressive du paiement

**Constat :** un élève pouvait arriver à l'étape "Moyen de paiement" pour une sélection ne couvrant en réalité aucune épreuve (0 résultat pour la combinaison filière/matière/année choisie), sans qu'aucun signal ne l'en informe avant.

**Solution :** sur le même principe déjà utilisé pour les champs qui apparaissent au fur et à mesure de la sélection, le moyen de paiement et le bouton de validation ne s'affichent désormais que lorsque le nombre d'épreuves couvertes par la sélection est strictement positif ; à 0, un message explicite remplace ces éléments plutôt que de les laisser accessibles pour un abonnement qui ne débloquerait rien. Voir Module 6.

### 14.12 Guide d'intégration du paiement réel

**Ajout :** `PAIEMENT.md`, un guide détaillé pour remplacer la simulation de paiement par une vraie intégration Notch Pay — création de compte, récupération des clés, initialisation d'un paiement, réception et vérification de signature du webhook, repli Monetbil, et une checklist avant mise en production. Écrit avec un avertissement explicite : les détails d'API peuvent évoluer, à revérifier sur la documentation officielle au moment de l'implémentation plutôt que suivre le guide aveuglément.

---

## 15. Évolutions fonctionnelles — version 2.3

Quatrième vague de retours d'usage sur le prototype fonctionnel, cette fois
axée sur des bugs concrets remontés en conditions d'usage réelles (pas
seulement des ajouts fonctionnels) — plusieurs ont pu être **reproduits et
vérifiés par un test isolé** avant correction, ce qui est noté
explicitement ci-dessous quand c'est le cas.

### 15.1 Bug d'authentification admin critique

**Constat :** `POST /api/admin/login` répondait 200 (connexion réussie),
mais l'appel suivant, `GET /api/admin/epreuves`, échouait systématiquement
en 401 — comme si le jeton de session venait d'être rejeté immédiatement
après avoir été délivré.

**Cause identifiée :** le client HTTP du frontend (`api.get()`)
n'acceptait un en-tête personnalisé (`X-Admin-Session`) que sur ses
méthodes `post`/`put`/`del`, jamais sur `get` — un oubli de signature qui
faisait partir silencieusement l'appel `GET` sans le jeton d'authentification.

**Solution :** signature de `api.get()` corrigée pour accepter des
en-têtes, comme les autres méthodes. Corrigé au passage : `load_dotenv()`
était appelé sans chemin explicite côté backend, ce qui ne trouvait le
fichier `.env` que si `uvicorn` était lancé depuis le dossier `backend/`
lui-même — lancé d'ailleurs, `ADMIN_EMAILS` et les autres variables
retombaient silencieusement sur leurs valeurs par défaut. Le chemin est
désormais résolu en absolu, comme `BASE_DIR` (voir section 3).

### 15.2 Persistance du verrou de session admin

**Constat :** le registre de la session admin active (Module 8, Module 1)
était tenu en mémoire (une simple variable Python), un choix assumé au
départ pour un prototype — mais qui signifiait qu'un redémarrage du
backend libérait silencieusement l'accès administrateur sans qu'aucune
déconnexion explicite n'ait eu lieu.

**Solution :** le verrou est désormais stocké en base (nouvelle table
`admin_lock`, une seule ligne, id fixe `"singleton"`) plutôt qu'en mémoire.
Seules l'expiration par inactivité (30 minutes, inchangé) ou une
déconnexion explicite libèrent maintenant l'accès.

### 15.3 Réponses de l'assistant en streaming (activé par défaut)

**Constat :** l'élève attendait en silence la réponse complète de
l'assistant avant de voir quoi que ce soit s'afficher — perçu comme lent,
en particulier sur une connexion mobile instable (persona élève, voir
section 2.1).

**Solution :** nouvel endpoint `POST /api/assistant/ask/stream`
(Server-Sent Events), qui consomme les endpoints de streaming natifs de
Gemini (`:streamGenerateContent?alt=sse`) et de Groq (API compatible
OpenAI, `stream: true`) — supportés par l'ensemble de leur catalogue de
modèles de chat respectif. Le message de l'élève est persisté
immédiatement (jamais perdu même si le flux est interrompu) ; celui de
l'assistant n'est persisté qu'une fois le flux terminé (texte accumulé
complet). Le frontend affiche le texte au fur et à mesure de sa réception.
L'endpoint historique non-streaming (`POST /api/assistant/ask`) reste
disponible pour compatibilité.

*Limite connue :* la liste des modèles supportant le streaming n'a pas pu
être vérifiée en direct contre la documentation officielle des limites de
débit de Groq au moment de l'écriture (environnement de développement sans
accès réseau sortant) — à revérifier avant production si un modèle Groq
non standard est configuré.

### 15.4 Images dans le contexte transmis à l'assistant

**Constat :** si un passage sélectionné par l'élève contenait une image
(schéma, graphique), celle-ci était ignorée par l'assistant — seul le
texte environnant était transmis.

**Solution :** le backend détecte les images Markdown (`![légende](url)`)
présentes dans le contexte transmis, résout leur chemin sur disque, et les
transmet en pièce jointe à Gemini (fournisseur multimodal). Avec Groq
(modèle texte seul), une note explicite dans le prompt signale qu'une
image a été ignorée, plutôt que de la perdre silencieusement.

### 15.5 Nouveau statut d'accès "Ouvert"

**Constat :** le catalogue ne distinguait que deux statuts, "Gratuit" et
"Payant" — une épreuve payante mais déjà débloquée par un abonnement actif
de l'élève restait affichée comme "Payant" (cadenas fermé), ce qui pouvait
laisser croire à tort qu'un nouveau paiement était nécessaire.

**Solution :** un troisième statut, "Ouvert" (cadenas ouvert, teinte
verte), calculé côté frontend à partir de la liste des abonnements actifs
de l'utilisateur (`GET /api/subscriptions/mine`) rapprochée des attributs
de chaque épreuve (même logique d'appartenance que `has_access` côté
serveur, section 11.1). Une épreuve "ouverte" se comporte comme une
épreuve gratuite pour la navigation (accès direct, pas de redirection vers
la page Abonnement) et est filtrable via une nouvelle option du filtre
"Accès" du catalogue.

### 15.6 Recherche insensible aux accents (bug reproduit et corrigé)

**Constat :** rechercher "éducation civique" dans le back-office ne
trouvait pas l'épreuve "Éducation Civique", pourtant bien présente.

**Cause identifiée et reproduite par un test isolé :** la fonction
`LOWER()` native de SQLite est strictement ASCII — `LOWER('Éducation')`
retourne `'Éducation'` inchangé, la lettre accentuée n'étant pas reconnue.
Comme SQLAlchemy traduit les recherches insensibles à la casse
(`.ilike()`) en `LOWER(colonne) LIKE LOWER(motif)` sur ce backend, toute
recherche impliquant un caractère accentué échouait silencieusement.

**Solution :** une fonction Python (`unicodedata`, qui décompose puis
retire les signes diacritiques en plus de gérer la casse Unicode
correctement) est enregistrée au niveau de la connexion SQLite pour
remplacer `LOWER()` — corrige ce bug pour TOUTE recherche `.ilike()` dans
l'application (back-office, filtres du catalogue), sans modifier une seule
ligne de code appelant ces recherches. Un équivalent JavaScript
(`foldText`) applique la même normalisation côté frontend pour les
recherches purement locales (menus déroulants, sélecteur d'épreuve de la
page Abonnement) — "éducation" y trouve désormais aussi "Éducation".

### 15.7 Refonte du panneau assistant

**Constats cumulés, remontés en plusieurs vagues :**
- Le panneau restait sombre dans les deux thèmes (contraire à l'attente
  qu'il suive le thème de la page comme le reste de l'interface).
- Plusieurs éléments (bulle de message utilisateur, bouton "Voir tout" du
  contexte, carte "Paiement en attente" de la page Abonnement) devenaient
  illisibles en mode sombre : `text-highlight-ink`, un token FIXE pensé
  pour du texte posé sur le fond `highlight` (jaune vif, ne change pas
  entre les deux thèmes), était utilisé par erreur sur `highlight-soft`
  (qui, lui, devient très sombre en mode sombre) — texte sombre sur fond
  sombre.
- Le panneau recouvrait le contenu plutôt que de s'ouvrir à côté sur
  bureau, et pouvait passer sous l'en-tête de l'application (absence de
  z-index explicite sur sa colonne latérale, alors que l'en-tête en
  déclare un).
- Une nouvelle discussion ouverte sans sélection préalable recevait une
  chaîne de contexte vide plutôt que le contenu intégral de l'épreuve.
- Les onglets de discussions multiples devenaient inaccessibles au-delà
  d'un certain nombre, cachés derrière le bouton "+" — cause identifiée :
  la disposition flexbox de l'en-tête (`flex-1 min-w-0`) ne confinait pas
  toujours le défilement au bon élément selon le contenu ; remplacée par
  une grille CSS (`minmax(0,1fr)` pour la colonne des onglets), un motif
  plus robuste pour ce cas précis.
- Une nouvelle sélection de texte pendant que le panneau était déjà ouvert
  ne produisait aucun effet visible, ou remplaçait à tort le contexte de
  la discussion en cours selon la version.
- Un panneau fraîchement ouvert recollait parfois le texte d'une
  sélection précédente dans le champ de saisie, sans nouvelle sélection —
  cause identifiée : la référence de garde contre les doublons démarrait à
  `null` à chaque nouveau montage, alors que le signal reçu pouvait déjà
  être non-nul (valeur laissée par une interaction précédente), ce qui
  faisait passer le contrôle d'égalité.
- Le champ de saisie, limité à une seule ligne, ne convenait pas à une
  question un peu longue.
- Les onglets "Passage sélectionné"/"Épreuve entière" étaient peu
  explicites sans repère visuel distinguant élève et assistant.

**Solutions apportées :**
- Le panneau suit désormais les tokens de couleur adaptatifs de la page
  (`paper`/`paper-raised`/`ink`) plutôt qu'un fond toujours sombre ;
  `text-ink` remplace `text-highlight-ink` partout où le fond associé
  était `highlight-soft` plutôt que `highlight`.
- Disposition en colonne latérale à côté du contenu sur bureau (avec un
  z-index explicite, supérieur à celui de l'en-tête), feuille modale sur
  mobile, et un troisième mode plein écran centré accessible via un bouton
  dédié dans l'en-tête du panneau.
- Une nouvelle discussion sans sélection préalable reçoit désormais le
  contenu intégral de l'épreuve (onglet actif) comme contexte, plutôt
  qu'une chaîne vide ; ce contexte, s'il est long, est affiché de façon
  condensée (aperçu + bouton "Voir tout") sans jamais tronquer ce qui est
  réellement transmis à l'assistant.
- En-tête du panneau réorganisé en grille CSS ; un nouvel onglet créé fait
  automatiquement défiler la barre pour rester visible.
- Comportement de sélection différencié selon l'état du panneau (voir
  Module 4 : "Copier dans le chat" vs "Demander à l'assistant"), sans
  jamais toucher au contexte d'une discussion déjà ouverte ; garde de
  déduplication renforcée (référence initialisée avec le nonce déjà
  présent au montage, pas avec `null`), avec une seconde protection côté
  page appelante qui réinitialise ce signal à chaque fermeture du panneau.
- Champ de saisie devenu multi-ligne (Entrée envoie, Maj+Entrée insère un
  saut de ligne), avec hauteur qui grandit jusqu'à un maximum avant de
  devenir défilable.
- Avatars (élève / assistant) ajoutés de part et d'autre de chaque bulle.
- Bouton "+ Nouvelle" (texte) remplacé par une icône "+" seule avec
  info-bulle, plus compact.

### 15.8 Rendu LaTeX toujours cassé sur certaines réponses (bug reproduit et corrigé)

**Constat :** malgré un premier correctif (section 14 d'une version
antérieure, conversion des délimiteurs `\( \)`/`\[ \]` vers `$...$`/`$$...$$`),
certaines réponses continuaient de s'afficher en texte brut non rendu,
backslashes compris — y compris des formules DÉJÀ correctement délimitées
par des signes dollar.

**Cause identifiée :** le moteur de rendu Markdown/LaTeX traite `$$...$$`
comme un CONSTRUIT DE BLOC, au même titre qu'un bloc de code clôturé par
des ``` — pas comme un délimiteur utilisable librement au milieu d'un
paragraphe. Un modèle qui écrit une formule `$$...$$` sans saut de ligne
l'isolant du texte environnant produit un bloc que le moteur ne reconnaît
pas comme une formule, et laisse tel quel en texte brut.

**Solution :** au-delà de la conversion des délimiteurs alternatifs déjà en
place, chaque occurrence de `$$...$$` — qu'elle vienne d'être convertie ou
qu'elle ait déjà été présente telle quelle dans la réponse du modèle — est
désormais isolée de force sur ses propres lignes, entourées de lignes
vides, quelle que soit la manière dont le modèle l'a formatée à l'origine.
L'instruction donnée au modèle a également été renforcée pour lui demander
explicitement de toujours placer `$$...$$` sur sa propre ligne. Reste un
traitement best-effort (pas un vrai parseur LaTeX), documenté comme
limitation connue.

### 15.9 Effets de clic/survol quasiment imperceptibles

**Constat :** la plupart des boutons ne donnaient aucun retour visuel
perceptible au clic, et l'effet de survol était nul ou quasi invisible sur
de nombreux éléments.

**Cause identifiée :** un `<button>` HTML n'a **pas** de curseur pointeur
par défaut dans la plupart des navigateurs (contrairement à une idée
répandue — seuls les liens `<a>` l'ont nativement), ce qui contribuait
fortement à l'impression d'interface peu réactive, en particulier sur des
éléments stylés comme des cartes plutôt que comme des boutons classiques.

**Solution :** `cursor: pointer` désormais appliqué explicitement à tout
élément cliquable, plus un état `:active` visible (teinte plus marquée au
clic qu'au survol) et un anneau de focus clavier global (`:focus-visible`)
qui n'existait pas du tout auparavant.

---

*Fin du document — Version 2.3*
