# Pagination des sujets — ÉTAT : IDÉE POUR PLUS TARD (documentation uniquement)

> **Décision (octobre 2026)** : rien n'est implémenté. Cette description est consignée pour
> une reprise ultérieure. Le lecteur présente déjà le texte sur une **feuille de largeur A4**
> (210 mm) à hauteur libre ; la **pagination** — de vraies pages A4 à l'intérieur d'un sujet —
> reste à faire.

## Besoin

Pouvoir lire un sujet comme une suite de feuilles A4 numérotées (« Page 2/5 »), avec des
sauts de page stables d'un appareil à l'autre. **« Page » ne veut donc pas dire « sujet »** :
le commutateur actuel « Page par page / Toutes les pages » pagine par *sujet*
(`lib/sujets.ts`), alors que la pagination vise les feuilles *dans* un sujet.

## État actuel (vérifié dans le code)

- Le contenu d'un sujet est du Markdown, rendu en HTML avec le suivi des positions source
  (`data-src-start` / `data-src-end`) qui sert aux notes et aux questions sur un passage.
- L'export PDF passe par `window.print()` (`ExportPdf.tsx`) : la pagination dépend du navigateur.
- L'import massif n'accepte que des archives `.zip` de Markdown (`routers/admin_import.py`).

## Principe retenu : les sauts de page sont dans le Markdown

La source de vérité est un **marqueur de saut de page** dans le texte (par exemple
`<!-- page -->`, invisible dans tout autre rendu). Pas de migration, pas de nouvelle table.
Les positions suivies pour les notes et les passages restent valides, puisque les marqueurs
font partie de la source.

## Trois façons de générer les marqueurs (elles peuvent coexister)

1. **Bouton « Paginer » dans l'éditeur admin** (recommandé). Un conteneur caché de
   210 × 297 mm, avec les mêmes polices que le lecteur, reçoit les blocs du sujet un par un ;
   quand un bloc déborde, on insère un marqueur juste avant lui. Règles :
   - garder un titre avec son premier paragraphe ;
   - ne jamais couper une formule, une figure ou un bloc de code ;
   - couper un tableau trop haut en répétant son en-tête ;
   - attendre `document.fonts.ready` et le rendu KaTeX avant de mesurer, et imposer
     `width`/`height` aux images pour éviter les reflows.
   L'aperçu côte à côte existant afficherait alors des feuilles numérotées, avec un
   avertissement rouge si une page dépasse.
2. **Pagination sémantique par l'assistant admin.** Il sait déjà proposer des modifications
   ciblées (`remplacer-sujet:N`, application automatique, « Annuler ») : une consigne
   « un exercice par page, regroupe les courts » produit des marqueurs au niveau des
   exercices. Moins fidèle à la mise en page, mais plus naturel.
3. **Script par lots** (`python -m app.scripts.paginer`, avec `--dry-run`) pour repaginer le
   corpus existant : Chromium sans interface applique le même algorithme que le bouton, puis
   écrit les marqueurs. Idempotent, il passe par `store.update_sujet` et écrit un journal
   d'audit.

## Côté lecteur

- `lib/sujets.ts` découpe déjà par sujet ; on y ajoute un découpage par marqueur.
- Chaque page devient une feuille `.feuille` avec son numéro, le filigrane par feuille, et la
  navigation ← → / PageUp / PageDown.
- « Page par page / Toutes les pages » passe à la feuille.
- Feuilles virtualisées (`IntersectionObserver`) pour les longs sujets.
- Impression : `break-after: page` par feuille et `@page { size: A4 }` : l'export PDF devient
  fidèle.
- Un sujet **sans marqueur** garde le comportement actuel : aucune régression.

## Mobile

On ne reflue pas le texte (cela déplacerait les sauts) : on réduit toute la feuille
(`zoom` ou `transform: scale`) pour qu'elle tienne en largeur, avec défilement vertical.

## Variante écartée

Un PDF généré côté serveur (WeasyPrint) donnerait des pages parfaitement stables, mais il
perd la sélection de texte, donc les notes et les questions sur un passage. La solution
ci-dessus garde les pages stables **et** le texte sélectionnable.

## Tests à prévoir

- Tests unitaires du découpeur sur des cas limites : bloc plus haut qu'une page, formule en
  fin de page, tableau long.
- Tests « golden » E2E sur des sujets de référence (nombre de pages attendu).
- Comparaison entre les mesures du bouton admin et celles du lecteur, pour éviter toute
  dérive entre les deux.

## Ordre de mise en œuvre

1. Découpage par marqueur et feuilles du lecteur (utile même avec des marqueurs saisis à la main).
2. Bouton « Paginer ».
3. Consigne de l'assistant.
4. Script par lots.

## À trancher avant de commencer

- Syntaxe exacte du marqueur et son comportement dans l'éditeur actuel.
- Hauteur minimale de la feuille (297 mm fixes ou hauteur libre).
- Polices auto-hébergées, pour que la mesure soit identique côté admin et côté lecteur.
- Effet de A−/A+ sur la feuille (aujourd'hui : zoom de la feuille entière).
