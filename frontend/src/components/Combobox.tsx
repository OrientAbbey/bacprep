import { ChevronDown } from "lucide-react";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { foldText } from "../lib/text";
import { t } from "../i18n";

export interface ComboOption {
  value: string;
  label: string;
}

/** Ferme `onOutside` quand un clic survient hors de `rootRef`. L'écouteur
 * document n'est posé QUE tant que `active` est vrai — aucune routine
 * dormante au niveau global entre deux ouvertures (É23). Hook local dans ce
 * fichier ; à extraire le jour d'une seconde utilisation (contrainte
 * « aucun nouveau fichier » du plan). */
function useClickOutside(
  rootRef: React.RefObject<HTMLElement | null>,
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

/**
 * Menu déroulant accessible avec recherche tapée.
 *
 * Navigation clavier prise en charge (bouton déclencheur ET liste
 * ouverte) :
 * - Entrée / Espace sur le déclencheur : ouvre le menu.
 * - Flèche bas / Flèche haut : ouvre le menu si fermé, sinon déplace la
 *   sélection surlignée d'une option.
 * - Home / End : saute à la première / dernière option visible.
 * - Entrée : valide l'option surlignée.
 * - Échap : ferme le menu et redonne le focus au bouton déclencheur.
 * - Tab : comportement natif (quitte le composant), le menu se ferme.
 */
export function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder = "Rechercher…",
}: {
  label: string;
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // IDs uniques par instance. En dur (`combo-opt-${i}`), deux Combobox de la
  // même page se volaient leurs identifiants et `aria-activedescendant`
  // désignait l'option de l'AUTRE liste.
  const id = useId();
  const labelId = `${id}-label`;
  const inputId = `${id}-input`;
  const listboxId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const selected = options.find((o) => o.value === value);

  // "Tous" (réinitialiser) est toujours la première entrée virtuelle de la
  // liste navigable au clavier, avant les options filtrées. La recherche
  // est insensible à la casse ET aux accents ("education" trouve
  // "Éducation") via foldText (voir lib/text.ts).
  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = foldText(query);
    return options.filter((o) => foldText(o.label).includes(q));
  }, [options, query]);

  const navigable: { value: string; label: string }[] = useMemo(
    () => [{ value: "", label: t("Tous") }, ...filtered],
    [filtered]
  );

  useClickOutside(rootRef, () => setOpen(false), open);

  useEffect(() => {
    if (open) {
      setHighlighted(0);
      // Focus différé sur le champ de recherche à l'ouverture, pour que
      // la frappe immédiate filtre la liste sans clic supplémentaire.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Garde l'option surlignée visible dans la liste lors de la navigation
    // au clavier (Flèche haut/bas peut sortir de la zone visible).
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function selectOption(index: number) {
    const opt = navigable[index];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted((i) => Math.min(i + 1, navigable.length - 1));
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
        setHighlighted(navigable.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        selectOption(highlighted);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setQuery("");
        triggerRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  const listeVide = filtered.length === 0;

  return (
    <div ref={rootRef} className="relative min-w-[160px]">
      {/* `htmlFor` indispensable : sans lui ce <label> ne labelait RIEN
          (le champ visé est plus bas dans l'arbre, hors de tout
          enfant), et le lecteur d'écran annonçait « boîte de saisie » nu. */}
      <label htmlFor={inputId} id={labelId} className="mb-1 block font-mono-tag text-[10px] text-ink-soft">
        {label}
      </label>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("{label} : {valeur}", { label, valeur: selected ? selected.label : t("Tous") })}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 py-2 text-left text-sm text-ink transition-colors hover:border-highlight/50"
      >
        <span className="truncate">{selected ? selected.label : t("Tous")}</span>
        <ChevronDown size={16} strokeWidth={1.75} className="shrink-0 text-ink-soft" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="absolute z-20 mt-1 w-full min-w-[220px] rounded-[2px] border border-ink-soft/20 bg-paper-raised shadow-lg"
          onKeyDown={onListKeyDown}
        >
          {/* Le CHAMP porte `role="combobox"` : c'est lui qui détient
              `aria-activedescendant` et `aria-controls` (ARIA 1.2). Placés
              sur le <ul>, ils étaient ignorés des lecteurs d'écran. */}
          <input
            ref={inputRef}
            id={inputId}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={listeVide ? undefined : listboxId}
            aria-activedescendant={listeVide ? undefined : optionId(highlighted)}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlighted(0);
            }}
            placeholder={placeholder}
            className="w-full border-b border-ink-soft/15 bg-transparent px-3 py-2 text-sm text-ink outline-none"
          />
          {listeVide ? (
            <p className="px-3 py-3 text-sm text-slate">{t("Aucun résultat")}</p>
          ) : (
            <ul ref={listRef} id={listboxId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto py-1">
              {navigable.map((o, i) => (
                // `role="option"` sur l'enfant DIRECT du listbox : il était
                // sur un <button> imbriqué dans un <li> sans rôle, donc
                // invisible pour la relation de parenté ARIA.
                <li
                  key={o.value || "__all__"}
                  data-index={i}
                  id={optionId(i)}
                  role="option"
                  aria-selected={value === o.value}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => selectOption(i)}
                  className={`min-h-[44px] cursor-pointer px-3 py-2 text-sm ${
                    highlighted === i ? "bg-highlight-soft" : ""
                  } ${value === o.value ? "font-medium text-ink" : "text-ink-soft"}`}
                >
                  {o.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
