import { useId } from "react";
import { FileText, Plus, X } from "lucide-react";
import { ApiError, resolveMediaUrl } from "../../api/client";
import { MarkdownContent } from "../../components/MarkdownContent";
import { formatBytes } from "../../lib/format";
import { formatRelativeTime } from "../../lib/time";

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
  contenu_markdown: string;
  corrige_markdown: string;
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
  contenu_markdown: "",
  corrige_markdown: "",
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
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
        className="min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-sm"
      />
    </div>
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

export function ContentBlock({
  title,
  required,
  markdown,
  preview,
  onTogglePreview,
  onChange,
  onUpload,
  assets,
  documents,
  onDeleteImage,
  onInsertImage,
  onDeleteDocument,
}: {
  title: string;
  required: boolean;
  markdown: string;
  preview: boolean;
  onTogglePreview: () => void;
  onChange: (v: string) => void;
  onUpload: (file: File) => void;
  assets: Asset[];
  documents: DocumentFile[];
  onDeleteImage: (asset: Asset) => void;
  onInsertImage: (asset: Asset) => void;
  onDeleteDocument: (doc: DocumentFile) => void;
}) {
  const textareaId = useId();
  return (
    <div className="space-y-2 border-t border-ink-soft/10 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="font-serif-brand text-lg">
          {title} {required && <span className="text-correction">*</span>}
        </h3>
        <button
          type="button"
          onClick={onTogglePreview}
          className="rounded-full border border-ink-soft/25 px-3 py-1 text-xs"
        >
          {preview ? "Texte" : "Rendu"}
        </button>
      </div>
      <p className="text-xs text-slate">
        Format attendu : titres Markdown, ancres <code>{"{#id}"}</code>, LaTeX <code>$...$</code>, tableaux
        Markdown, images <code>![légende](url)</code>.
      </p>

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
                  className="p-1 text-ink-soft hover:text-correction"
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
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
                <button
                  type="button"
                  onClick={() => onInsertImage(a)}
                  title="Insérer la balise Markdown de cette image dans le texte"
                  aria-label="Insérer cette image dans le texte"
                  className="absolute bottom-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-valide text-paper shadow"
                >
                  <Plus size={12} strokeWidth={2.5} aria-hidden="true" />
                </button>
              </div>
            ))}
            {/* Métadonnées des fichiers : dimensions et poids, visibles en
                clair sous la rangée de vignettes (aussi en info-bulle). */}
            <div className="w-full space-y-0.5 text-xs text-slate">
              {assets.map((a) => (
                <p key={`meta-${a.id}`} className="truncate">
                  <span className="font-mono-tag text-[10px]">{a.filename}</span>
                  {a.width && a.height ? ` · ${a.width}×${a.height} px` : ""}
                  {a.size_bytes ? ` · ${formatBytes(a.size_bytes)}` : ""}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}