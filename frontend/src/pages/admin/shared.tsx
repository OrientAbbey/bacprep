import { useId, useRef } from "react";
import { FileText, FileUp, Plus, X } from "lucide-react";
import { ApiError, resolveMediaUrl } from "../../api/client";
import { MarkdownContent } from "../../components/MarkdownContent";
import { formatBytes } from "../../lib/format";
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
  session: string;
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

export const EMPTY_FORM: EpreuveForm = {
  niveau: "SECONDAIRE",
  classe: "terminale",
  evaluation: "BAC",
  matiere: "",
  annee: "",
  session: "",
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

export function Field({
  label,
  value,
  onChange,
  placeholder,
  list,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** id d'une `<datalist>` de suggestions (champ libre enrichi). */
  list?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        list={list}
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

export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Liste déroulante MODIFIABLE : un champ de saisie libre enrichi d'une
 * `<datalist>` de suggestions (niveau, classe, évaluation, matière,
 * session). L'admin peut choisir une valeur connue OU taper la sienne —
 * le serveur normalise au besoin (niveau/classe/évaluation passent par le
 * référentiel à l'enregistrement) et mémorise les valeurs hors liste. */
export function EditableSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const id = useId();
  const listId = `suggest-${id}`;
  // Affiche le libellé lisible quand la valeur courante est un code connu
  // (ex. "terminale" → "Terminale") ; sinon la saisie libre brute.
  const affiche = options.find((o) => o.value === value)?.label ?? value;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        value={affiche}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={false}
        aria-label={label}
        list={listId}
        className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.label} />
        ))}
      </datalist>
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