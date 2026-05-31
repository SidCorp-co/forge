"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";
import { Input } from "@/design/primitives/input";
import { Kbd } from "@/design/primitives/kbd";
import { Kicker } from "@/design/primitives/kicker";

/** Palette group keys, rendered top-to-bottom in this order. */
export type CommandGroup = "recent" | "pinned" | "navigate" | "actions" | "search";

const GROUP_ORDER: CommandGroup[] = ["recent", "pinned", "navigate", "actions", "search"];
const GROUP_LABEL: Record<CommandGroup, string> = {
  recent: "Recent",
  pinned: "Pinned",
  navigate: "Navigate",
  actions: "Actions",
  search: "Search results",
};

export interface Command {
  label: string;
  icon: IconName;
  kbd?: string;
  /** Section to render under. Defaults to "navigate". */
  group?: CommandGroup;
  /** Extra terms matched against the query (not displayed). */
  keywords?: string;
  onRun?: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // Filter by label + keywords, then keep a single FLAT list (ordered by group)
  // so ↑/↓/Enter traverse every result regardless of section boundaries.
  const flat = useMemo(() => {
    const q = query.toLowerCase().trim();
    const matched = commands.filter(
      (c) =>
        !q ||
        c.label.toLowerCase().includes(q) ||
        (c.keywords ? c.keywords.toLowerCase().includes(q) : false),
    );
    return matched
      .map((c, i) => ({ cmd: c, i }))
      .sort(
        (a, b) =>
          GROUP_ORDER.indexOf(a.cmd.group ?? "navigate") -
            GROUP_ORDER.indexOf(b.cmd.group ?? "navigate") || a.i - b.i,
      )
      .map((x) => x.cmd);
  }, [commands, query]);

  // Group the flat list while preserving each item's flat index (for selection).
  const sections = useMemo(() => {
    const byGroup = new Map<CommandGroup, Array<{ cmd: Command; idx: number }>>();
    flat.forEach((cmd, idx) => {
      const g = cmd.group ?? "navigate";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push({ cmd, idx });
    });
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, [flat]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, flat.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = flat[active];
        if (cmd) {
          cmd.onRun?.();
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, flat, active, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]"
      style={{ background: "rgba(24,27,34,0.25)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <div
        className="forge-drop w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2.5 border-b border-line-subtle px-4 py-3">
          <Icon name="search" size={18} className="text-subtle" />
          <Input
            variant="bare"
            className="flex-1"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search or run a command…"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1.5">
          {flat.length === 0 && <p className="fg-body-sm px-3 py-6 text-center">No matches.</p>}
          {sections.map((section, si) => (
            <div key={section.group}>
              {si > 0 && <div className="my-1 border-t border-line-subtle" />}
              <Kicker className="block px-3 pb-1 pt-1.5">{GROUP_LABEL[section.group]}</Kicker>
              <ul>
                {section.items.map(({ cmd, idx }) => (
                  <li key={`${cmd.label}-${idx}`}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => {
                        cmd.onRun?.();
                        onClose();
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                        idx === active ? "bg-accent-tint text-accent-text" : "text-fg hover:bg-hover",
                      )}
                    >
                      <Icon
                        name={cmd.icon}
                        size={17}
                        style={idx === active ? { color: "var(--accent)" } : { color: "var(--fg-subtle)" }}
                      />
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.kbd && <Kbd>{cmd.kbd}</Kbd>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
