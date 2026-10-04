import { getLang, setLang, type Lang } from "./i18n";

/** Sélecteur FR/EN. Changer de langue RECHARGE la page : `t()` est une fonction
 * simple (y compris pour les constantes de module), le rechargement est le
 * moyen le plus court de tout retraduire, et le changement de langue est rare. */
export function LangSwitch({ className = "" }: { className?: string }) {
  const lang = getLang();
  return (
    <div role="group" aria-label="Langue / Language" className={`flex rounded-full border border-ink-soft/25 text-xs ${className}`}>
      {(["fr", "en"] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          onClick={() => {
            if (lang === l) return;
            setLang(l);
            window.location.reload();
          }}
          className={`min-h-[36px] min-w-[36px] rounded-full px-2 uppercase ${lang === l ? "bg-ink text-paper" : "text-ink-soft"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
