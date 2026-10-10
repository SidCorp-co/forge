// The viewport-relative heights a scrolling region takes, by name: written out whole so Tailwind sees
// every class. A feature asks for one by what it is and, where it holds only at some widths, from where.

const HEIGHTS = {
  /** A working pane that scrolls inside itself: most of the viewport. */
  pane: { all: "h-[70dvh]", "max-md": "max-md:h-[70dvh]", "max-lg": "max-lg:h-[70dvh]" },
  /** The page below the top bar. */
  page: { all: "h-[calc(100dvh-48px)]", lg: "lg:h-[calc(100dvh-48px)]" },
  /** A sticky side column: the viewport less its margin, scrolled. */
  sticky: { all: "max-h-[calc(100dvh-2rem)] overflow-y-auto", lg: "lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto" },
  /** A sheet dropped over the page: at most two fifths of the viewport, scrolled. */
  sheet: { all: "max-h-[40dvh] overflow-y-auto" },
  /** An anchored popup's list: the room its positioner leaves, and never more than 20rem. */
  popup: { all: "max-h-[min(var(--available-height),20rem)] overflow-y-auto" },
} as const;

type Heights = typeof HEIGHTS;
type At = { [S in keyof Heights]: keyof Heights[S] }[keyof Heights];

/** The classes for a named viewport height; `at` limits it to the widths a variant names. */
export function fixedHeight(size: keyof Heights, at: At = "all"): string {
  const classes: Partial<Record<At, string>> = HEIGHTS[size];
  return classes[at] ?? "";
}
