import { useEffect, useState } from "react";
import { ZoomIn, ZoomOut, X } from "lucide-react";
import { t } from "../i18n";

/**
 * Visionneuse plein écran d'une image (loupe). Clic sur une image d'épreuve
 * ou d'une discussion → superposition sombre centrée avec un mode zoom :
 * bouton loupe (ou clic sur l'image) pour basculer « ajuster à l'écran » /
 * « taille agrandie », fermeture par ×, touche Échap ou clic sur le fond.
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `Image : ${alt}` : t("Image de l'épreuve")}
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-full max-w-full items-center justify-center"
      >
        <img
          src={src}
          alt={alt || ""}
          onClick={() => setZoomed((z) => !z)}
          title={zoomed ? t("Réduire (touche Échap pour fermer)") : t("Agrandir (touche Échap pour fermer)")}
          className={`rounded-lg object-contain shadow-2xl transition-transform duration-200 ${
            zoomed ? "max-h-none max-w-none scale-[1.9] cursor-zoom-out" : "max-h-[86vh] max-w-[86vw] cursor-zoom-in"
          }`}
        />
        <div className="absolute top-2 right-2 flex gap-2">
          <button
            type="button"
            onClick={() => setZoomed((z) => !z)}
            title={zoomed ? t("Réduire") : "Agrandir"}
            aria-label={zoomed ? t("Réduire l'image") : "Agrandir l'image"}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white transition-colors hover:bg-black/85"
          >
            {zoomed ? <ZoomOut size={18} strokeWidth={2} aria-hidden="true" /> : <ZoomIn size={18} strokeWidth={2} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t("Fermer (touche Échap)")}
            aria-label={t("Fermer la visionneuse d'image")}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white transition-colors hover:bg-black/85"
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {alt && (
          <p className="absolute right-2 bottom-2 left-2 truncate rounded bg-black/60 px-3 py-1 text-center text-xs text-white">
            {alt}
          </p>
        )}
      </div>
    </div>
  );
}