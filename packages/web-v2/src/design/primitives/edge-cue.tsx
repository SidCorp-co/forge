import { cn } from "@/lib/utils/cn";

/** The fade over a horizontal scroller's edge while content sits out of view past it. */
export function EdgeCue({
  side,
  visible,
  surface = "surface",
}: {
  side: "start" | "end";
  visible: boolean;
  /** The background the scroller sits on, which the fade dissolves into. */
  surface?: "surface" | "app";
}) {
  const bg = surface === "app" ? "var(--bg-app)" : "var(--bg-surface)";
  return (
    <span
      aria-hidden
      data-edge={side}
      data-visible={visible}
      style={{
        backgroundImage:
          side === "start"
            ? `linear-gradient(to right, var(--scrim), transparent 10px), linear-gradient(to right, ${bg}, transparent)`
            : `linear-gradient(to left, var(--scrim), transparent 10px), linear-gradient(to left, ${bg}, transparent)`,
      }}
      className={cn(
        "pointer-events-none absolute inset-y-0 w-8 opacity-0 motion-safe:transition-opacity data-[visible=true]:opacity-100",
        side === "start" ? "left-0" : "right-0",
      )}
    />
  );
}
