import type { HealthMarkerKind } from "@forge/contracts/workflow-health";
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

/** One hue per health marker kind (REQ-17 BC-16), each a themed canvas token. */
export const HEALTH_HUE: Record<HealthMarkerKind, string> = {
  has_problem: hue("red"),
  wrong: hue("orange"),
  outdated: hue("amber"),
  not_in_design: hue("violet"),
  remove_proposed: hue("pink"),
  needs_update: hue("blue"),
  upcoming: hue("slate"),
};
