import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { resolveMediaUrl } from "../api/client";
import { rehypeSourceOffsets, rehypeStripAnchorText } from "../lib/markdownSource";
import { rehypeImageWidths } from "../lib/markdownImages";
import { normalizeLatexDelimiters } from "../lib/latex";

/** Réécrit les URL d'image relatives (`/media/...`) en URL absolues vers
 * le backend — sans quoi les images d'une épreuve (ou d'un message
 * assistant) apparaissent cassées en développement (frontend et backend
 * sur des origines différentes). Voir `resolveMediaUrl` dans api/client.ts.
 *
 * Les liens `<a>` sont filtrés : seuls http, https, mailto et les chemins
 * internes `/api/files/` sont autorisés — empêche les liens
 * `javascript:...` injectés via le Markdown (XSS au clic). */
const SAFE_HREF_RE = /^(https?:\/\/|mailto:|\/api\/files\/)/i;

const markdownComponents = {
  img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line jsx-a11y/alt-text
    <img
      {...props}
      src={props.src ? resolveMediaUrl(props.src) : props.src}
      loading="lazy"
      decoding="async"
    />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const href = props.href ?? "";
    if (!SAFE_HREF_RE.test(href)) {
      return <span {...props} />;
    }
    return <a {...props} />;
  },
};

export const MarkdownContent = React.memo(function MarkdownContent({
  content,
  variant,
  trackSourcePositions = false,
}: {
  content: string;
  variant: "epreuve" | "chat";
  /**
   * Si vrai, pose des attributs data-src-start/data-src-end (voir
   * lib/markdownSource) permettant de retrouver le Markdown BRUT
   * correspondant à une sélection de texte. Uniquement utilisé côté
   * lecteur (ViewerPage) — jamais dans les bulles de discussion.
   *
   * Le Markdown reçu ici n'est JAMAIS pré-nettoyé au niveau chaîne de
   * caractères (ce qui décalerait les offsets par rapport au texte
   * d'origine) : les ancres {#id} sont retirées uniquement à l'affichage,
   * via un plugin rehype qui ne touche pas aux positions (voir
   * rehypeStripAnchorText).
   */
  trackSourcePositions?: boolean;
}) {
  const rehypePlugins = useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>>(
    () =>
      trackSourcePositions
        ? [rehypeKatex, rehypeImageWidths, rehypeSourceOffsets, rehypeStripAnchorText]
        : [rehypeKatex, rehypeImageWidths, rehypeStripAnchorText],
    [trackSourcePositions]
  );

  // Normalisation des délimiteurs LaTeX alternatifs (\( \), \[ \],
  // \begin{...} nu) UNIQUEMENT pour les bulles de discussion (contenu
  // généré par le LLM, moins prévisible que le Markdown d'épreuve saisi
  // par l'admin) — jamais quand trackSourcePositions est actif, puisque
  // cette normalisation change la longueur de la chaîne et décalerait les
  // offsets de sélection calculés sur le texte d'origine.
  const normalized = useMemo(
    () => (variant === "chat" ? normalizeLatexDelimiters(content) : content),
    [content, variant]
  );

  return (
    <div className={variant === "epreuve" ? "prose-exam" : "prose-chat"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

