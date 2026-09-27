import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, FileText, FileUp, Plus, X } from "lucide-react";
import { ApiError, resolveMediaUrl } from "../../api/client";
import { MarkdownContent } from "../../components/MarkdownContent";
import { formatBytes } from "../../lib/format";
import { foldText } from "../../lib/text";
import { formatRelativeTime } from "../../lib/time";

/** Échappe un texte pour l'insérer dans une regex (caractères spéciaux). */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** URL de base d'une image (/api/files/{id}) SANS jeton signé ni fragment :
 * la balise du Markdown porte un jeton (parfois l'ancien, celui de l'upload)
 * alors que assets[].url est fraîchement re-signé à chaque GET — le matching
 * ne doit JAMAIS dépendre du jeton, sinon resize/suppression échouent après
 * un rechargement (revue 2026-09, REVUE_FRONTEND.md F1). */
function urlSansJeton(url: string): string {
  return url.split("?")[0].split("#")[0];
}

/** Balise image Markdown d'une image donnée dans un bloc de texte :
 * extrait la largeur d'affichage `#w=NNN` éventuelle pour synchroniser
 * le sélecteur « Taille d'affichage » et détecter une double insertion. */
export function extraireBaliseImage(markdown: string, url: string): { presente: boolean; largeur: number } {
  const base = escapeRegExp(urlSansJeton(url));
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${base}(?:\\?[^#)]*)?(?:#w=(\\d+))?\\)`);
  const match = re.exec(markdown);
  if (!match) return { presente: false, largeur: 0 };
  return { presente: true, largeur: match[1] ? Number(match[1]) : 0 };
}

/** Réécrit la largeur d'affichage (`#w=NNN`) d'une balise image
 * existante — l'ajoute si la balise est présente sans largeur, la
 * retire si `width` vaut 0 (« Pleine »). Si la balise est absente la
 * chaîne n'est pas modifiée. Le jeton éventuel de la balise (indépendant
 * de celui de `assets[].url`) est ignoré par le matching.
 * Le fragment est réinséré AVANT la parenthèse fermante `)` (un ajout
 * après provoquait `#w=640` hors balise — couvert par shared.test.ts). */
export function remplacerLargeur(markdown: string, url: string, width: number): string {
  const base = escapeRegExp(urlSansJeton(url));
  // {1} préfixe (jusqu'au premier `#` ou `)`) {2} largeur éventuelle {3} `)`.
  const re = new RegExp(`(!\\[[^\\]]*\\]\\(${base}[^)#]*)(?:#w=\\d+)?(\\))`);
  const frag = width && width > 0 ? `#w=${width}` : "";
  return markdown.replace(re, (_all, prefix: string, closing: string) => `${prefix}${frag}${closing}`);
}

/** Image rattachée au sujet ou au corrigé d'une épreuve. */
export interface Asset {
  id: string;
  cible: "sujet" | "corrige";
  format: "md" | "image";
  filename: string;
  url: string;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  mime_type?: string;
  doublon_de?: string | null;
}

/** Contenu éditable d'un sujet d'épreuve (sujet + corrigé optionnel). */
export interface SujetFormData {
  index: number;
  contenu_markdown: string;
  corrige_markdown: string;
}

export interface EpreuveForm {
  id?: string;
  niveau: string;
  classe: string;
  evaluation: string;
  matiere: string;
  annee: string;
  duree: string;
  coefficient: string;
  gratuit: boolean;
  filieres: string[];
  /** Les sujets de l'épreuve — au moins un (index 0 = sujet principal). */
  sujets: SujetFormData[];
  assets: Asset[];
  /** Documents Markdown (sujet.md / corrige.md) — séparés des images pour
   * ne plus apparaître comme des « images rattachées » dans la galerie. */
  documents: DocumentFile[];
}

/** Document Markdown attaché au sujet ou au corrigé (liste texte, pas une
 * vignette d'image). */
export interface DocumentFile {
  id: string;
  cible: "sujet" | "corrige";
  filename: string;
  size_bytes?: number | null;
  uploaded_at?: string | null;
}

/** Formulaire d'épreuve à VIDE : la création ne préremplit AUCUN champ
 * (revue 2026-09-18) — les libellés « ex. … » accompagnent l'admin, le
 * serveur normalise au besoin à l'enregistrement. */
export const EMPTY_FORM: EpreuveForm = {
  niveau: "",
  classe: "",
  evaluation: "",
  matiere: "",
  annee: "",
  duree: "",
  coefficient: "",
  gratuit: false,
  filieres: [],
  sujets: [{ index: 0, contenu_markdown: "", corrige_markdown: "" }],
  assets: [],
  documents: [],
};

/** Authentification admin — DEPUIS la migration sécurité É15, le jeton de
 * session voyage dans un cookie httpOnly (SameSite=Strict) posé par le
 * serveur à la connexion : il n'existe PLUS en JavaScript (un XSS
 * même-origine ne peut plus l'exfiltrer) et part automatiquement avec
 * chaque requête même-origine (credentials: "include" du client API). Ce
 * helper ne renvoie donc plus d'en-tête : il est conservé pour ne pas
 * modifier les dizaines d'appels existants. */
export function authHeaders(_token?: string): Record<string, string> {
  return {};
}

/** 401 dans un panneau (verrou admin expiré pendant l'inactivité) : signale
 * le retour au formulaire de connexion AU LIEU d'un rechargement complet de
 * la page. AdminPage écoute l'événement `admin:session-expiree` et purge
 * sa session locale → la page repasse par la connexion au lieu d'afficher
 * une « liste vide » trompeuse. Retourne vrai si c'était un 401 (les
 * autres erreurs restent à la charge de l'appelant). */
export function purgerSessionExpiree(err: unknown): boolean {
  if (!(err instanceof ApiError && err.status === 401)) return false;
  window.dispatchEvent(new Event("admin:session-expiree"));
  return true;
}

/** Message d'erreur lisible depuis une exception API : le `detail` brut du
 * serveur (chaîne FastAPI ou liste d'erreurs de validation 422) quand il est
 * exploitable, sinon le libellé générique fourni par l'appelant. Evite les
 * toasts trompeurs (« Échec de l'enregistrement ») quand le serveur sait
 * dire exactement ce qui coince (revue 2026-09-18). */
export function erreurDetail(err: unknown, defaut: string): string {
  if (err instanceof ApiError) {
    const d = err.detail;
    if (typeof d === "string" && d.trim()) return d;
    if (Array.isArray(d) && d.length > 0) {
      const messages = d
        .map((x) => (x && typeof x === "object" && "msg" in x ? String((x as { msg: unknown }).msg) : ""))
        .filter(Boolean);
      if (messages.length > 0) return messages.join(" · ");
    }
  }
  return defaut;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  obligatoire,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Champ requis — une étoile accompagne le libellé (blocage à
   * l'enregistrement par l'appelant). */
  obligatoire?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
        {label} {obligatoire && <span className="text-correction">*</span>}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
      />
    </div>
  );
}

/** Description « Format attendu » partagée par les deux zones de contenu
 * (sujet et corrigé) : un résumé + un bloc dépliable listant le Markdown
 * accepté. Rédigée comme un prompt — un admin qui colle un document brut
 * comprend d'emblée ce que l'éditeur attend et ce qui sera filtré. */
export function FormatAttendu() {
  return (
    <details className="group rounded-lg border border-ink-soft/15 bg-paper/60 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-slate group-open:text-ink">
        Format attendu — Markdown enrichi (titres, formules, tableaux, images)
      </summary>
      <div className="mt-2 space-y-1.5 text-xs text-slate">
        <p>Un sujet/corrigé est rédigé en Markdown : il peut utiliser :</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            les <strong>titres hiérarchisés</strong> <code>#</code>, <code>##</code>, <code>###</code> pour
            structurer les parties ;
          </li>
          <li>les paragraphes, <strong>listes</strong> à puces ou numérotées et <strong>tableaux</strong> Markdown ;</li>
          <li>
            les <strong>formules</strong> : <code>$…$</code> en ligne, <code>$$…$$</code> en bloc (environnements
            LaTeX placés <em>dans</em> <code>$$…$$</code>) ;
          </li>
          <li>
            les <strong>images</strong> <code>![légende](/api/files/…)</code>, avec une largeur d'affichage
            optionnelle <code>#w=300</code> (le rendu du lecteur la respecte) ;
          </li>
          <li>
            les <strong>ancres</strong> <code>{"{#id}"}</code> après un titre pour les renvois entre
            énoncés ;
          </li>
          <li>le code court <code>`…`</code> ou en blocs <code>```</code>.</li>
        </ul>
        <p>
          Le HTML brut est ignoré au rendu, et seuls les liens <code>http(s)</code>, <code>mailto:</code> et
          internes sont conservés. Rien d'autre n'est nécessaire : pas d'en-tête, pas de style.
        </p>
      </div>
    </details>
  );
}

/** Élément d'une liste déroulante du back-office (code stocké + libellé
 * affiché). */
export interface OptionChoix {
  value: string;
  label: string;
}

/** Ferme le panneau quand un clic survient hors de `rootRef` — l'écouteur
 * document n'est posé QUE tant que le panneau est ouvert (aucune routine
 * dormante au niveau global, même convention que le Combobox du catalogue). */
function useClickOutside(
  rootRef: React.RefObject<HTMLDivElement | null>,
  onOutside: () => void,
  active: boolean
) {
  useEffect(() => {
    if (!active) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onOutside();
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [rootRef, onOutside, active]);
}

/** Panneau de liste COMMUN aux deux déclencheurs du back-office (`Select`
 * non modifiable et `EditableSelect` modifiable) : même design que le
 * Combobox du catalogue — option surlignée au survol/navigation, option
 * courante en gras, Échap pour fermer. Les valeurs d'une liste restent
 * ISOLÉES dans ce panneau : plus de `<datalist>` native dont les
 * suggestions se mélangeaient entre champs, ni de chevron système qui se
 * superposait au chevron dessiné (double chevron dès le survol — revue
 * 2026-09-18). */
function ListeOptions({
  value,
  options,
  highlighted,
  onHighlight,
  onSelect,
  idPrefix,
  listboxId,
  label,
}: {
  value: string;
  options: OptionChoix[];
  highlighted: number;
  onHighlight: (i: number) => void;
  onSelect: (v: string) => void;
  /** Préfixe d'identifiants UNIQUE par champ : en dur, les `id` de tous les
   * sélecteurs d'un formulaire d'épreuve se recouvraient et
   * `aria-activedescendant` pointait vers l'option d'un AUTRE champ. */
  idPrefix: string;
  listboxId: string;
  label: string;
}) {
  if (options.length === 0) {
    return <p className="px-3 py-3 text-sm text-slate">Aucun résultat</p>;
  }
  return (
    <ul id={listboxId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto py-1">
      {options.map((o, i) => (
        // `role="option"` sur l'enfant DIRECT du listbox (et non sur un
        // <button> imbriqué dans un <li> sans rôle) : sinon la relation de
        // parenté ARIA est rompue et le lecteur d'écran voit une liste vide.
        <li
          key={o.value}
          id={`${idPrefix}-${i}`}
          data-option={i}
          role="option"
          aria-selected={value === o.value}
          onMouseEnter={() => onHighlight(i)}
          onClick={() => onSelect(o.value)}
          className={`min-h-[44px] cursor-pointer px-3 py-2 text-sm ${
            highlighted === i ? "bg-highlight-soft" : ""
          } ${value === o.value ? "font-medium text-ink" : "text-ink-soft"}`}
        >
          {o.label}
        </li>
      ))}
    </ul>
  );
}

/** Liste déroulante NON modifiable du back-office : remplacer une valeur
 * connue par une autre. Entièrement customisée (bouton + panneau, comme le
 * Combobox du catalogue) : un SEUL chevron dessiné, aucune flèche système. */
export function Select({
  label,
  value,
  onChange,
  options,
  placeholder = "—",
  obligatoire,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: OptionChoix[];
  placeholder?: string;
  /** Champ requis — une étoile accompagne le libellé. */
  obligatoire?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === value);
  // Identifiants propres à CETTE instance (un formulaire d'épreuve en compte
  // plusieurs sur la même page).
  const uid = useId();
  const labelId = `${uid}-label`;
  const listboxId = `${uid}-listbox`;
  const idPrefix = `${uid}-option`;

  useClickOutside(rootRef, () => setOpen(false), open);

  // À l'ouverture, surligne la valeur courante (sinon la première option).
  useEffect(() => {
    if (!open) return;
    const i = options.findIndex((o) => o.value === value);
    setHighlighted(i >= 0 ? i : 0);
  }, [open, options, value]);

  // Garde l'option surlignée visible pendant la navigation au clavier.
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-option="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function choisir(v: string) {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setHighlighted(0);
        break;
      case "End":
        e.preventDefault();
        setHighlighted(options.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (options[highlighted]) choisir(options[highlighted].value);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <label id={labelId} className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
        {label} {obligatoire && <span className="text-correction">*</span>}
      </label>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        // `aria-labelledby` plutôt qu'un `aria-label` figé : l'astérisque
        // « obligatoire » est ainsi annoncé avec le nom du champ.
        aria-labelledby={labelId}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${idPrefix}-${highlighted}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 py-2 text-left text-sm text-ink transition-colors hover:border-highlight/50"
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <ChevronDown size={16} strokeWidth={1.75} className="shrink-0 text-ink-soft" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="absolute z-20 mt-1 w-full min-w-[220px] rounded-[2px] border border-ink-soft/20 bg-paper-raised shadow-lg"
          onKeyDown={onPanelKeyDown}
        >
          <ListeOptions
            value={value}
            options={options}
            highlighted={highlighted}
            onHighlight={setHighlighted}
            onSelect={choisir}
            idPrefix={idPrefix}
            listboxId={listboxId}
            label={label}
          />
        </div>
      )}
    </div>
  );
}

/** Liste déroulante MODIFIABLE du back-office : saisie libre enrichie d'une
 * liste de suggestions (niveau, classe, évaluation, année, matière, type de
 * notification). Choisir une suggestion la valide telle quelle ; taper
 * n'importe quoi reste possible (le serveur normalise au besoin et mémorise
 * les valeurs hors liste). Même apparence que `Select`, même chevron unique. */
export function EditableSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
  obligatoire,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: OptionChoix[];
  placeholder?: string;
  /** Champ requis — une étoile accompagne le libellé. */
  obligatoire?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Identifiants propres à CETTE instance (voir `Select`).
  const uid = useId();
  const inputId = `${uid}-input`;
  const listboxId = `${uid}-listbox`;
  const idPrefix = `${uid}-option`;

  // Affiche le libellé lisible quand la valeur courante est un code connu
  // (ex. "terminale" → "Terminale") ; sinon la saisie libre brute.
  const affiche = options.find((o) => o.value === value)?.label ?? value;

  useClickOutside(rootRef, () => setOpen(false), open);

  // Suggestions filtrées par la saisie courante (insensible casse/accents) —
  // la saisie reste libre, le filtre ne fait que resserrer la cible.
  const suggestions = useMemo(() => {
    if (!affiche.trim()) return options;
    const q = foldText(affiche);
    return options.filter((o) => foldText(o.label).includes(q) || foldText(o.value).includes(q));
  }, [options, affiche]);

  useEffect(() => {
    if (!open) return;
    const i = suggestions.findIndex((o) => o.value === value);
    setHighlighted(i >= 0 ? i : 0);
    // Focus différé : la frappe immédiate filtre la liste sans clic en plus.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, suggestions, value]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-option="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function choisir(v: string) {
    onChange(v);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === "Enter") {
      // Listes ouverte : Entrée valide la suggestion surlignée ; fermée :
      // Entrée soumet le formulaire (comportement natif conservé).
      if (open && suggestions.length > 0) {
        e.preventDefault();
        choisir(suggestions[highlighted]?.value ?? affiche);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted((i) => Math.min(i + 1, suggestions.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setHighlighted(0);
        break;
      case "End":
        e.preventDefault();
        setHighlighted(suggestions.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (suggestions[highlighted]) choisir(suggestions[highlighted].value);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        inputRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <label htmlFor={inputId} className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
        {label} {obligatoire && <span className="text-correction">*</span>}
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          value={affiche}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-autocomplete="list"
          // `aria-label` retiré : le <label htmlFor> labellise désormais
          // réellement le champ (il ne le faisait pas avant, le champ étant
          // hors de tout enfant du <label>).
          aria-controls={open && suggestions.length > 0 ? listboxId : undefined}
          aria-activedescendant={open && suggestions.length > 0 ? `${idPrefix}-${highlighted}` : undefined}
          className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 pr-10 text-sm text-ink transition-colors hover:border-highlight/50 focus:border-highlight/60 focus:outline-none"
        />
        {/* Chevron dessiné UNIQUE : la gestion est 100 % customisée — aucune
            flèche système ne peut se superposer (celle du `<input list>`
            apparaissait DÈS LE SURVOL, doublon systématique — revue
            2026-09-18). `onMouseDown` prévient la bascule focus→blur qui
            refermerait puis rouvrirait le panneau. */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
          className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-r-[2px] text-ink-soft transition-colors hover:text-ink"
        >
          <ChevronDown size={16} strokeWidth={1.75} className="pointer-events-none" />
        </button>
      </div>
      {open && (
        <div
          className="absolute z-20 mt-1 w-full min-w-[220px] rounded-[2px] border border-ink-soft/20 bg-paper-raised shadow-lg"
          onKeyDown={onPanelKeyDown}
        >
          <ListeOptions
            value={value}
            options={suggestions}
            highlighted={highlighted}
            onHighlight={setHighlighted}
            onSelect={choisir}
            idPrefix={idPrefix}
            listboxId={listboxId}
            label={label}
          />
        </div>
      )}
    </div>
  );
}

export function ContentBlock({
  title,
  required,
  markdown,
  preview,
  onTogglePreview,
  onChange,
  onUpload,
  onImportMarkdown,
  assets,
  documents,
  onDeleteImage,
  onInsertImage,
  onResizeImage,
  onDeleteDocument,
}: {
  title: string;
  required: boolean;
  markdown: string;
  preview: boolean;
  onTogglePreview: () => void;
  onChange: (v: string) => void;
  onUpload: (file: File) => void;
  onImportMarkdown: (text: string) => void;
  assets: Asset[];
  documents: DocumentFile[];
  onDeleteImage: (asset: Asset) => void;
  onInsertImage: (asset: Asset, width?: number) => void;
  /** Redimensionne (réécrit `#w=NNN` de la balise existante) ou insère la
   * balise avec la largeur choisie si l'image n'est pas encore dans le
   * texte — appelé par le sélecteur « Taille d'affichage ». */
  onResizeImage?: (asset: Asset, width: number) => void;
  onDeleteDocument: (doc: DocumentFile) => void;
}) {
  const textareaId = useId();
  const importRef = useRef<HTMLInputElement>(null);
  // La largeur affichée est LUE depuis le Markdown lui-même (jamais d'état
  // local dérivé) : le sélecteur reste synchronisé avec la balise réelle
  // après une édition manuelle du texte, un changement d'onglet sujet, etc.
  const largeurs = (a: Asset) => extraireBaliseImage(markdown, a.url);
  return (
    <div className="space-y-2 border-t border-ink-soft/10 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-serif-brand text-lg">
          {title} {required && <span className="text-correction">*</span>}
        </h3>
        <div className="flex items-center gap-2">
          {/* Import Markdown d'un fichier .md fourni par un collègue : le
              contenu est recopié dans la zone de texte de la cible. */}
          <input
            ref={importRef}
            type="file"
            accept=".md,.markdown,text/markdown"
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                file.text().then(onImportMarkdown).catch(() => undefined);
              }
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            title="Importer un fichier Markdown (.md) dans cette zone de texte"
            className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-xs"
          >
            <FileUp size={13} strokeWidth={1.75} aria-hidden="true" />
            Importer un .md
          </button>
          <button
            type="button"
            onClick={onTogglePreview}
            className="min-h-[44px] rounded-full border border-ink-soft/25 px-3 text-xs"
          >
            {preview ? "Texte" : "Rendu"}
          </button>
        </div>
      </div>
      <FormatAttendu />

      {preview ? (
        <div className="max-h-[420px] overflow-y-auto rounded-lg border border-ink-soft/15 p-3">
          <MarkdownContent content={markdown} variant="epreuve" />
        </div>
      ) : (
        <>
          <label htmlFor={textareaId} className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
            Contenu Markdown
          </label>
          <textarea
            id={textareaId}
            value={markdown}
            onChange={(e) => onChange(e.target.value)}
            rows={10}
            className="w-full rounded-[2px] border border-ink-soft/25 bg-paper p-3 font-mono text-sm"
          />
        </>
      )}

      <div>
        {/* Documents Markdown de cette cible : liste TEXTE (distincte de la
            galerie d'images) — corrige l'affichage « sujet.md » comme si
            c'était une image rattachée au sujet. */}
        {documents.length > 0 && (
          <ul className="mb-2 space-y-1">
            {documents.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-2 rounded-lg border border-ink-soft/15 bg-paper px-2 py-1.5 text-xs"
              >
                <FileText size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-soft" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono-tag text-[10px]">{d.filename}</span>
                  {d.size_bytes ? ` · ${formatBytes(d.size_bytes)}` : ""}
                  {d.uploaded_at ? ` · ${formatRelativeTime(d.uploaded_at)}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteDocument(d)}
                  title="Supprimer ce document"
                  aria-label={`Supprimer le document ${d.filename}`}
                  className="relative p-1 text-ink-soft hover:text-correction after:absolute after:-inset-[12px] after:rounded-full after:content-['']"
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-ink-soft">Image :</span>
            <input
              type="file"
              accept="image/*"
              className="block cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-paper"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {assets.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {assets.map((a) => (
              <div
                key={a.id}
                className="group relative h-16 w-16 overflow-hidden rounded-lg border border-ink-soft/20 bg-paper"
                title={`${a.filename}${a.width && a.height ? ` — ${a.width}×${a.height}` : ""}${
                  a.size_bytes ? ` — ${formatBytes(a.size_bytes)}` : ""
                }`}
              >
                <img
                  src={resolveMediaUrl(a.url)}
                  alt={a.filename}
                  className="h-full w-full object-contain"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => onDeleteImage(a)}
                  title="Retirer cette image (supprime le fichier)"
                  aria-label="Retirer cette image"
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-correction text-paper shadow"
                >
                  <X size={12} strokeWidth={2.5} aria-hidden="true" />
                </button>
                {/* Le bouton « + » n'apparaît QUE quand la balise est
                    absente du texte ; quand elle est présente, le sélecteur
                    « Taille d'affichage » en dessous gère le redimensionnement. */}
                {!largeurs(a).presente && (
                  <button
                    type="button"
                    onClick={() => onInsertImage(a, largeurs(a).largeur || undefined)}
                    title="Insérer la balise Markdown de cette image dans le texte"
                    aria-label="Insérer cette image dans le texte"
                    className="absolute bottom-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-valide text-paper shadow"
                  >
                    <Plus size={12} strokeWidth={2.5} aria-hidden="true" />
                  </button>
                )}
                {largeurs(a).presente && (
                  <span
                    title="Image déjà insérée — modifier la taille ci-dessous"
                    className="absolute bottom-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/60 bg-ink/50 text-[8px] font-bold text-paper shadow"
                  >
                    #
                  </span>
                )}
              </div>
            ))}
            {/* Métadonnées des fichiers : dimensions, poids et taille
                d'affichage choisie, visibles en clair sous la rangée de
                vignettes (aussi en info-bulle). La taille d'affichage est
                persistée dans la balise Markdown à l'insertion (#w=NNN). */}
            <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate">
              {assets.map((a) => (
                <p key={`meta-${a.id}`} className="flex items-center gap-2">
                  <span className="font-mono-tag text-[10px]">{a.filename}</span>
                  {a.width && a.height ? ` · ${a.width}×${a.height} px` : ""}
                  {a.size_bytes ? ` · ${formatBytes(a.size_bytes)}` : ""}
                  <label className="flex items-center gap-1">
                    <span className="sr-only">Taille d'affichage de {a.filename}</span>
                    <select
                      value={largeurs(a).largeur}
                      onChange={(e) => {
                        const w = Number(e.target.value);
                        if (onResizeImage) onResizeImage(a, w);
                      }}
                      className="rounded-[2px] border border-ink-soft/25 bg-paper px-1.5 py-0.5 text-xs"
                    >
                      <option value={0}>Pleine</option>
                      <option value={240}>240 px</option>
                      <option value={320}>320 px</option>
                      <option value={480}>480 px</option>
                      <option value={640}>640 px</option>
                    </select>
                  </label>
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}