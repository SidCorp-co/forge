"use client";

import {
  useCallback, useEffect, useId, useRef, useState, type SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface SelectOption {
  value: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * Accessible custom listbox (WAI-ARIA combobox pattern) — styled options with
 * icons + a selected check, brand-consistent popover, full keyboard support:
 * ↑/↓ move, Enter/Space select, Esc close, Home/End jump, type-ahead. Focus
 * returns to the trigger on close. For a plain OS control use NativeSelect.
 */
export function Select({
  options, value, onChange, placeholder = "Select…", disabled, id, invalid,
  className, ...aria
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef("");
  const typeaheadAt = useRef(0);
  const baseId = useId();
  const selected = options.find((o) => o.value === value);
  const isInvalid = invalid || (aria as Record<string, unknown>)["aria-invalid"] === true;

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) btnRef.current?.focus();
  }, []);

  const openList = useCallback(() => {
    if (disabled) return;
    const i = options.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : options.findIndex((o) => !o.disabled));
    setOpen(true);
  }, [disabled, options, value]);

  const commit = useCallback(
    (i: number) => {
      const o = options[i];
      if (!o || o.disabled) return;
      onChange?.(o.value);
      close();
    },
    [options, onChange, close],
  );

  const move = useCallback(
    (dir: 1 | -1) => {
      setActive((cur) => {
        let i = cur;
        for (let n = 0; n < options.length; n++) {
          i = (i + dir + options.length) % options.length;
          if (!options[i].disabled) return i;
        }
        return cur;
      });
    },
    [options],
  );

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // keep active option in view
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(1); break;
      case "ArrowUp": e.preventDefault(); move(-1); break;
      case "Home": e.preventDefault(); setActive(options.findIndex((o) => !o.disabled)); break;
      case "End": e.preventDefault(); { const r = [...options].reverse().findIndex((o) => !o.disabled); setActive(r < 0 ? 0 : options.length - 1 - r); } break;
      case "Enter": case " ": e.preventDefault(); commit(active); break;
      case "Escape": e.preventDefault(); close(); break;
      case "Tab": close(false); break;
      default:
        if (e.key.length === 1) {
          const now = Date.now();
          typeahead.current = now - typeaheadAt.current > 800 ? e.key : typeahead.current + e.key;
          typeaheadAt.current = now;
          const q = typeahead.current.toLowerCase();
          const i = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(q));
          if (i >= 0) setActive(i);
        }
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${baseId}-list`}
        aria-invalid={isInvalid || undefined}
        aria-describedby={aria["aria-describedby"] as string | undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border bg-surface py-2 pl-3 pr-2.5 text-left text-sm transition-shadow",
          "focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          isInvalid ? "border-[color:var(--red-500)] focus-visible:border-[color:var(--red-500)]" : "border-line-strong focus-visible:border-[color:var(--link)]",
        )}
      >
        {selected?.icon && <Icon name={selected.icon} size={16} className="text-subtle" />}
        <span className={cn("flex-1 truncate", selected ? "text-fg" : "text-disabled")}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevronDown" size={16} className="text-subtle" />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={`${baseId}-list`}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${baseId}-opt-${active}`}
          className="forge-drop absolute z-50 mt-1.5 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-lg"
        >
          {options.map((o, i) => {
            const isSel = o.value === value;
            const isActive = i === active;
            return (
              <li
                key={o.value}
                id={`${baseId}-opt-${i}`}
                data-idx={i}
                role="option"
                aria-selected={isSel}
                aria-disabled={o.disabled || undefined}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onClick={() => commit(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px]",
                  o.disabled && "cursor-not-allowed opacity-50",
                  isActive && !o.disabled ? "bg-accent-tint text-accent-text" : "text-fg",
                )}
              >
                {o.icon && <Icon name={o.icon} size={16} style={isActive ? { color: "var(--accent)" } : { color: "var(--fg-subtle)" }} />}
                <span className="flex-1 truncate">{o.label}</span>
                {isSel && <Icon name="check" size={15} strokeWidth={2.5} style={{ color: "var(--accent)" }} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface NativeSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: SelectOption[];
}

/** Plain OS-native select, styled to match Input — preferred where the native
    mobile picker / minimal JS is wanted. */
export function NativeSelect({ options, className, ...props }: NativeSelectProps) {
  return (
    <div className="relative inline-flex w-full items-center">
      <select
        className={cn(
          "w-full appearance-none rounded-md border border-line-strong bg-surface py-2 pl-3 pr-9 text-sm text-fg",
          "transition-shadow focus-visible:border-[color:var(--link)] focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={16} className="pointer-events-none absolute right-3 text-subtle" />
    </div>
  );
}
