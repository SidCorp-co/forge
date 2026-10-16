import type { CSSProperties } from "react";

// The binding's accent is data the client chose, so it is applied as a runtime value: the frame's
// root overrides the design tokens its primary button and focus ring read, in both themes. The ink on
// it is black or white, whichever reads better (WCAG relative luminance).

const ACCENT = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The ink that reads on `accent`: black on a light accent, white on a dark one. */
export function inkOn(accent: string): "black" | "white" {
  const l = luminance(accent);
  // contrast with black (l + 0.05) / 0.05 against with white 1.05 / (l + 0.05): the higher wins
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "black" : "white";
}

export function accentStyle(accent: string | null): CSSProperties | undefined {
  if (!accent || !ACCENT.test(accent)) return undefined;
  const ink = inkOn(accent);
  const shade = ink === "white" ? "black" : "white";
  return {
    "--primary": accent,
    "--accent": accent,
    "--accent-9": accent,
    "--accent-hover": `color-mix(in srgb, ${accent} 86%, ${shade})`,
    "--accent-press": `color-mix(in srgb, ${accent} 76%, ${shade})`,
    "--primary-foreground": ink,
    "--fg-on-accent": ink,
    "--shadow-focus-accent": `0 0 0 3px color-mix(in srgb, ${accent} 40%, transparent)`,
  } as CSSProperties;
}
