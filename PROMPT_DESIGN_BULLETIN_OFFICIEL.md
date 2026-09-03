# Prompt de design — "Bulletin Officiel" (Copies & Corrigés)

> Ce document est autonome et complète `PROMPT_RECONSTRUCTION.md`. Il
> **remplace la section 6.1** ("Design system") de ce dernier et
> **précise** les sections 6.4/6.5 (composants et pages) avec des
> valeurs concrètes plutôt que des noms de tokens abstraits. Tout le
> reste de `PROMPT_RECONSTRUCTION.md` (architecture, backend, modèle de
> données, tests) reste inchangé : ce document ne concerne que
> l'identité visuelle du frontend.

---

## 0. Principe directeur

**Signature du direction : le document administratif camerounais.**
Bandeau tricolore en en-tête, encre bleu marine, sceau concentrique sur
le contenu gratuit — l'application doit se lire comme un document
officiel numérisé (au sens propre : ce sont de vraies épreuves du
Baccalauréat), pas comme une app de note-taking générique. Un seul
signe distinctif est utilisé par surface (jamais deux effets décoratifs
cumulés sur le même écran) : le reste de l'interface reste sobre pour
laisser ce signe respirer.

Le mode sombre n'est **pas** une simple inversion mécanique : il
reprend l'esprit "étude nocturne" (bleu quasi noir, doré réchauffé,
lueur discrète autour de l'assistant) tout en gardant la même
sémantique de couleur que le mode clair (bleu marine = encre, doré =
accent, rouge = correction, vert = validé).

---

## 1. Palette

Tous les hex ci-dessous sont prêts à coller dans `src/index.css` (voir
section 8). Les noms de tokens reprennent exactement ceux déjà
spécifiés dans `PROMPT_RECONSTRUCTION.md` section 6.1.

### Mode clair

| Token | Hex | Rôle |
|---|---|---|
| `--color-paper` | `#F6F2E7` | Fond de page (papier bulletin) |
| `--color-paper-raised` | `#FFFFFF` | Cartes, champs de formulaire |
| `--color-ink` | `#1B2A4A` | Texte principal (bleu marine) |
| `--color-ink-soft` | `#4B5A78` | Texte secondaire |
| `--color-slate` | `#8791A3` | Texte tertiaire, métadonnées discrètes |
| `--color-highlight` | `#C89B3C` | Accent doré (surlignage, badges actifs) |
| `--color-highlight-soft` | `#F3E7C8` | Fond léger sur accent doré |
| `--color-correction` | `#B23A2E` | Rouge correcteur / verrouillé |
| `--color-correction-soft` | `#F1DBD7` | Fond léger sur rouge |
| `--color-valide` | `#2F6E4F` | Vert validation / gratuit |
| `--color-valide-soft` | `#DCEAE1` | Fond léger sur vert |
| `--color-margin` | `#14213D` | Fond du panneau assistant (fixe, sombre dans les 2 thèmes) |
| `--color-margin-soft` | `#1D2E52` | Bulles/éléments internes du panneau assistant |

### Mode sombre (`.dark`) — inspiré de la révision nocturne

| Token | Hex | Rôle |
|---|---|---|
| `--color-paper` | `#0F1626` | Fond de page (bleu quasi noir) |
| `--color-paper-raised` | `#182236` | Cartes, champs de formulaire |
| `--color-ink` | `#ECEDF2` | Texte principal (clair) |
| `--color-ink-soft` | `#9CA7BF` | Texte secondaire |
| `--color-slate` | `#6B7690` | Texte tertiaire |
| `--color-highlight` | `#D6AE55` | Doré réchauffé (plus lumineux sur fond sombre) |
| `--color-highlight-soft` | `#3A2E12` | Fond léger sur accent doré |
| `--color-correction` | `#E0665A` | Rouge, éclairci pour le contraste |
| `--color-correction-soft` | `#3A211C` | Fond léger sur rouge |
| `--color-valide` | `#59B98A` | Vert, éclairci pour le contraste |
| `--color-valide-soft` | `#163828` | Fond léger sur vert |
| `--color-margin` | `#070B14` | Fond du panneau assistant (encore plus sombre — reste "toujours sombre") |
| `--color-margin-soft` | `#101827` | Bulles/éléments internes |

### Tokens FIXES (jamais redéfinis dans `.dark`, identiques aux 2 tableaux)

| Token | Hex | Pourquoi fixe |
|---|---|---|
| `--color-highlight-ink` | `#241A02` | Texte sur fond doré (`highlight`), qui ne change pas de teinte entre les 2 thèmes |
| `--color-margin-text` | `#F1EFE6` | Texte à l'intérieur du panneau assistant, dont le fond reste sombre dans les 2 thèmes |

Vérification de contraste : `#241A02` sur `#C89B3C` (clair) et sur
`#D6AE55` (sombre) — ratio > 7:1 dans les deux cas. `#F1EFE6` sur
`#14213D` et sur `#070B14` — ratio > 11:1 dans les deux cas.

---

## 2. Typographie

Polices déjà fixées par le cahier des charges (Source Serif 4, IBM
Plex Sans, IBM Plex Mono) — **inchangées**. Cette piste les utilise
ainsi :

- **Source Serif 4**, graisse **700**, casse phrase (jamais de
  majuscules) : nom de marque dans l'AppBar, titres d'épreuve dans le
  catalogue, en-tête du lecteur, prix dans le récapitulatif
  d'abonnement. Le poids 700 (plutôt que 600) porte volontairement le
  ton "document officiel" — plus affirmé qu'un simple titre éditorial.
- **IBM Plex Sans**, 400 pour le corps de texte, 500 pour les
  boutons/liens de navigation/labels de formulaire.
- **IBM Plex Mono**, TOUJOURS en majuscules avec `letter-spacing:
  0.08em–0.09em`, jamais en minuscules : ligne de métadonnées du
  lecteur ("BAC 2023 · MATHÉMATIQUES · SÉRIES C · D · E"), badges de
  filière, labels de section ("CONSULTÉES RÉCEMMENT"), méthodes de
  paiement. Ce traitement mono/majuscule/tracké est ce qui donne
  l'impression d'un numéro de dossier ou d'un tampon administratif.

---

## 3. Iconographie

Lucide React exclusivement (aucun emoji nulle part). Trait
`strokeWidth={1.75}`. Tailles : 20px dans la nav de l'AppBar, 18px sur
les boutons icône, 16px dans les badges/chips, 14px dans les tags
compacts (verrou, check).

Icônes clés : `ArrowLeft` (retour), `ChevronDown` (combobox),
`X` (fermer un onglet), `Plus` (nouvelle conversation), `Lock`
(épreuve payante), `Check` (corrigé disponible / validé), `User`
(profil), `MessageCircle` (assistant), `Send` (envoyer un message),
`SunMoon` ou équivalent (bascule thème).

---

## 4. Motifs signature (un seul par surface)

1. **Bandeau tricolore** — barre de 3px en tout haut de l'AppBar,
   divisée en trois segments égaux : `valide` (vert) · `highlight`
   (doré) · `correction` (rouge). Présent uniquement sur l'AppBar
   (donc visible sur toutes les pages puisque l'AppBar est commun),
   jamais répété ailleurs sur la page — c'est la signature globale de
   l'app, pas un élément décoratif à réutiliser.
2. **Sceau concentré** — le badge "Gratuit" sur une carte épreuve est
   entouré d'un double anneau (`border: 1px solid var(--color-valide)`
   + `box-shadow: 0 0 0 2px var(--color-paper), 0 0 0 3px
   var(--color-valide-soft)`), comme un cachet d'authenticité sur un
   document. Ce traitement n'apparaît QUE sur ce badge précis.
3. **Double filet (letterhead)** — sur la page Lecteur uniquement, un
   séparateur à deux traits fins (1px plein, 3px de blanc, 1px plein,
   couleur `ink-soft` à 20% d'opacité) sous la ligne de métadonnées
   mono, avant le contenu de l'épreuve — rappelle l'en-tête d'un
   document officiel.

Aucune texture de fond, aucun papier vieilli, aucun tampon dessiné à la
main ailleurs : la sobriété du reste de l'interface est ce qui fait
ressortir ces trois signes.

---

## 5. Composants (`src/components/`) — précisions visuelles

- **`Logo.tsx`** — monogramme "C" (ou pictogramme document+coche) sur
  fond `ink`, glyphe en `paper`, coins `radius: 7px`. Couleurs fixes
  (identité de marque), ne suit jamais le thème actif.
- **`Layout.tsx`** — bandeau tricolore en premier enfant du `<header>`
  (voir motif 1). En dessous : logo + nom de marque (Source Serif 4,
  700), nav (`Catalogue`/`Abonnement`/`Admin`), bascule thème, icône
  profil. Fond `paper-raised`, bordure basse 1px `ink-soft` à 15%
  d'opacité. Comportement responsive inchangé (masque nom de marque et
  lien Admin sous 640px).
- **`MetaBadge.tsx`** — badges de filière : bordure 1px `ink-soft` à
  25%, fond `paper`, texte mono majuscule. Le tone `highlight` utilise
  `text-highlight-ink` (jamais `text-ink`, cf. contraste section 1).
- **`Combobox.tsx`** — coins carrés à peine arrondis (`radius: 2px`,
  pas de pilule) pour évoquer un champ de formulaire administratif,
  fond `paper-raised`, chevron Lucide `ChevronDown`.
- **`Watermark.tsx`** — inchangé fonctionnellement (pattern SVG répété
  sur toute la hauteur), couleur `ink` à 4% d'opacité.
- **`FloatingAskButton.tsx`** — pilule fond `ink`, texte `paper`, icône
  `MessageCircle`. Coordonnées viewport-fixes (voir contrainte déjà
  actée dans `PROMPT_RECONSTRUCTION.md` 6.4 — ne pas ajouter
  `scrollY`/`scrollX`).
- **`AssistantLauncherButton.tsx`** — pilule fond `margin`, texte
  `margin-text`, libellé toujours "Assistant". En mode sombre, légère
  lueur discrète : `box-shadow: 0 0 0 5px rgba(214,174,85,0.14)`
  (référence à l'ambiance "étude nocturne").
- **`AssistantPanel.tsx`** — fond `margin` (fixe, sombre dans les 2
  thèmes), texte `margin-text` partout. Onglets = pilules
  `margin-soft`, fermeture via icône `X` 12px. Bouton "+ Nouvelle" fixe
  hors défilement, bordure `rgba(255,255,255,.22)`. Bulle utilisateur
  = `margin-soft` alignée à droite ; bulle assistant = transparente,
  bordure `rgba(255,255,255,.15)`, alignée à gauche. Bouton d'envoi
  circulaire rempli `highlight`, icône `Send` en `highlight-ink`.
- **`GoogleSignInButton.tsx`** — inchangé fonctionnellement, style
  neutre (le bouton Google conserve son apparence standard imposée par
  Google, ne pas le rethémer).

---

## 6. Pages (`src/pages/`) — précisions visuelles

**`LoginPage.tsx`** — carte centrée sur fond `paper`, bandeau tricolore
visible en haut de l'écran (premier contact avec la marque), logo
grand format.

**`CataloguePage.tsx`** — filtres en `Combobox` coins carrés ; deux
groupes de chips (`Corrigé`, `Accès`) en pilules mono ; section
"Consultées récemment" en scroll horizontal (scrollbar masquée) ;
cartes épreuve : titre Source Serif 4/700, ligne de métadonnées mono
majuscule avec séparateur `·`, badge "Gratuit" en sceau (motif 2),
badge payant = icône `Lock` + prix sur fond `correction-soft`.

**`ViewerPage.tsx`** — ligne de métadonnées mono majuscule, double
filet en dessous (motif 3), bascule Sujet/Corrigé en pilule (`ink`
actif). Passage sélectionné = fond `highlight` / texte
`highlight-ink`. `FloatingAskButton` positionné près de la sélection.

**`SubscribePage.tsx`** — chips de portée (5), portée active = fond
`highlight` / texte `highlight-ink` en gras. Carte récapitulative :
lignes séparées par un filet pointillé fin (`border-bottom: 1px dashed`,
`ink-soft` 20%) façon registre comptable ; prix en Source Serif 4/700 ;
méthodes de paiement en petites pastilles mono (pas de logos de marque
Orange/MTN, juste un point de couleur + libellé texte, pour éviter tout
usage non autorisé de logo). CTA visible uniquement si le nombre
d'épreuves couvertes est strictement positif (comportement fonctionnel
inchangé, déjà spécifié).

**`ProfilePage.tsx`** — mêmes cartes `paper-raised` et filets
pointillés que la page Abonnement pour les abonnements actifs (cohérence
visuelle "registre").

**`AdminPage.tsx`** — mêmes tokens de couleur mais **sans** motifs
signature (pas de sceau, pas de bandeau tricolore répété au-delà de
l'AppBar) : l'admin est un outil interne, les signes de marque sont
réservés à l'expérience élève.

---

## 7. Web vs mobile (Capacitor)

- Breakpoint < 640px : masque le nom de marque texte et le lien Admin
  (comportement déjà spécifié, inchangé).
- **Panneau assistant** : sur desktop, panneau latéral fixe déclenché
  par le bouton flottant (disposition multi-onglets telle que décrite).
  Sur mobile (< 640px), le panneau s'ouvre en feuille modale plein
  écran depuis le bas plutôt qu'en colonne latérale — la disposition
  lecteur+assistant en deux colonnes devient une colonne unique, le
  bouton flottant restant visible au-dessus du contenu.
- **Grille catalogue** : 3 colonnes desktop → 1 colonne mobile ; les
  filtres passent sur plusieurs lignes ; la bande "consultées
  récemment" reste en défilement horizontal sur les deux formats.
- **Statut natif (Capacitor, note d'implémentation)** : comme le
  bandeau tricolore occupe le tout premier pixel de l'écran, configurer
  la couleur de la barre de statut native (plugin `@capacitor/status-bar`)
  sur `--color-margin` avec icônes claires, pour éviter un conflit visuel
  entre la barre système et le bandeau. Point à traiter lors de
  l'intégration Capacitor réelle (hors périmètre du prototype actuel
  selon `PROMPT_RECONSTRUCTION.md` section 10, mais à garder en tête
  pour la phase Capacitor).

---

## 8. Bloc CSS prêt à coller (`src/index.css`)

Remplace le bloc de tokens de la section 6.1 de
`PROMPT_RECONSTRUCTION.md` par celui-ci (structure Tailwind v4
identique, seules les valeurs changent) :

```css
@theme {
  --color-paper: #F6F2E7;
  --color-paper-raised: #FFFFFF;
  --color-ink: #1B2A4A;
  --color-ink-soft: #4B5A78;
  --color-slate: #8791A3;
  --color-highlight: #C89B3C;
  --color-highlight-soft: #F3E7C8;
  --color-highlight-ink: #241A02;
  --color-correction: #B23A2E;
  --color-correction-soft: #F1DBD7;
  --color-valide: #2F6E4F;
  --color-valide-soft: #DCEAE1;
  --color-margin: #14213D;
  --color-margin-soft: #1D2E52;
  --color-margin-text: #F1EFE6;
}

.dark {
  --color-paper: #0F1626;
  --color-paper-raised: #182236;
  --color-ink: #ECEDF2;
  --color-ink-soft: #9CA7BF;
  --color-slate: #6B7690;
  --color-highlight: #D6AE55;
  --color-highlight-soft: #3A2E12;
  --color-correction: #E0665A;
  --color-correction-soft: #3A211C;
  --color-valide: #59B98A;
  --color-valide-soft: #163828;
  --color-margin: #070B14;
  --color-margin-soft: #101827;
  /* --color-highlight-ink et --color-margin-text : PAS redéfinis ici, volontairement */
}
```

---

## 9. Note d'intégration

Pour reconstruire l'application avec cette identité : donner à Claude
**les deux documents ensemble** (`PROMPT_RECONSTRUCTION.md` +
`PROMPT_DESIGN_BULLETIN_OFFICIEL.md`), avec l'instruction explicite que
ce second document fait autorité sur toute la partie visuelle
(couleurs, typographie, motifs) et remplace la section 6.1 du premier,
tout le reste (backend, modèle de données, tests) restant piloté par
`PROMPT_RECONSTRUCTION.md` sans changement.
