import type { MessageEntry } from "@/features/session/types";

// cm:edge contract -> packages/core/src/assistant/confab.ts:correctionLine — the exact sentence core appends under a reply that told a refused write as done; a change to its wording there leaves these lines rendered as prose here
const CORRECTION = /^Correction: (.+) was refused \(([^)\n]*)\); nothing was written\.$/;

export interface Correction {
  line: string;
  what: string;
  code: string;
}

export function splitCorrections(text: string): { prose: string; corrections: Correction[] } {
  const corrections: Correction[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(CORRECTION);
    if (m) corrections.push({ line: line.trim(), what: m[1] as string, code: m[2] as string });
    else kept.push(line);
  }
  if (corrections.length === 0) return { prose: text, corrections };
  return { prose: kept.join("\n").trimEnd(), corrections };
}

export function withoutCorrections(entry: MessageEntry): { entry: MessageEntry; corrections: Correction[] } {
  const found = new Map<string, Correction>();
  const strip = (t: string) => {
    const s = splitCorrections(t);
    for (const c of s.corrections) found.set(c.line, c);
    return s.prose;
  };
  const content = typeof entry.content === "string" ? strip(entry.content) : entry.content;
  const blocks = entry.blocks?.map((b) => (b.type === "text" && typeof b.text === "string" ? { ...b, text: strip(b.text) } : b));
  if (found.size === 0) return { entry, corrections: [] };
  return {
    entry: { ...entry, ...(content !== undefined ? { content } : {}), ...(blocks ? { blocks } : {}) },
    corrections: [...found.values()],
  };
}
