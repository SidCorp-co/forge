export interface ProjectMarkProps {
  /** Tint background (a brand tint token, e.g. `var(--cobalt-50)`). */
  tint: string;
  /** Ink/foreground color (e.g. `var(--cobalt-700)`). */
  ink: string;
  initials: string;
  size?: number;
  radius?: string;
}

/** The square, monospace project glyph used in the switcher + console. */
export function ProjectMark({ tint, ink, initials, size = 36, radius = "var(--r-md)" }: ProjectMarkProps) {
  return (
    <span
      className="inline-flex flex-none items-center justify-center font-mono font-bold"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: tint,
        color: ink,
        fontSize: size * 0.34,
        letterSpacing: "0.01em",
      }}
    >
      {initials}
    </span>
  );
}
