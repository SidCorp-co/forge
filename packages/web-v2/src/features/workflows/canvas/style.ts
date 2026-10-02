import type { TemplateEdgeKind } from "@forge/contracts/workflow-templates";

/** A template colour token as the CSS variable the canvas reads (`styles/tokens.css` --wf-*). */
export const hue = (colour: string) => `var(--wf-${colour})`;

export const tint = (colour: string, percent: number, over = "var(--bg-app)") =>
  `color-mix(in srgb, ${hue(colour)} ${percent}%, ${over})`;

export const DASH: Record<TemplateEdgeKind["line"], string | undefined> = {
  solid: undefined,
  dashed: "6 4",
  dotted: "2 4",
};

export const edgeHue = (kind: TemplateEdgeKind) => (kind.colour === "neutral" ? "var(--wf-edge)" : hue(kind.colour));

export const MARK_HUE = { added: "var(--green-500)", changed: "var(--amber-500)", removed: "var(--red-500)" } as const;
