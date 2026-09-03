import { ChevronDown } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { foldText } from "../lib/text";

export interface ComboOption {
  value: string;
  label: string;
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
    () => [{ value: "", label: "Tous" }, ...filtered],
    [filtered]
  );

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

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

  return (
    <div ref={rootRef} className="relative min-w-[160px]">
      <label className="mb-1 block font-mono-tag text-[10px] text-ink-soft">{label}</label>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 py-2 text-left text-sm text-ink transition-colors hover:border-highlight/50"
      >
        <span className="truncate">{selected ? selected.label : "Tous"}</span>
        <ChevronDown size={16} strokeWidth={1.75} className="shrink-0 text-ink-soft" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="absolute z-20 mt-1 w-full min-w-[220px] rounded-[2px] border border-ink-soft/20 bg-paper-raised shadow-lg"
          onKeyDown={onListKeyDown}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlighted(0);
            }}
            placeholder={placeholder}
            className="w-full border-b border-ink-soft/15 bg-transparent px-3 py-2 text-sm text-ink outline-none"
          />
          <ul ref={listRef} role="listbox" aria-activedescendant={`combo-opt-${highlighted}`} className="max-h-64 overflow-y-auto py-1">
            {navigable.map((o, i) => (
              <li key={o.value || "__all__"} role="option" aria-selected={value === o.value} data-index={i}>
                <button
                  id={`combo-opt-${i}`}
                  type="button"
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => selectOption(i)}
                  className={`min-h-[44px] w-full px-3 py-2 text-left text-sm ${
                    highlighted === i ? "bg-highlight-soft" : ""
                  } ${value === o.value ? "font-medium text-ink" : "text-ink-soft"}`}
                >
                  {o.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
