import { Icon } from "@/design/icons/icon";
import { ProgressBar } from "@/design/primitives/progress-bar";

/* Root Suspense fallback — shown while an async route segment streams.
   Calm brand splash, not a bare spinner. */
export default function Loading() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-app">
      <span className="forge-pulse inline-flex size-12 items-center justify-center rounded-xl" style={{ background: "var(--flame-500)", color: "#fff" }}>
        <Icon name="pipeline" size={26} strokeWidth={2} />
      </span>
      <div className="w-40">
        <ProgressBar indeterminate />
      </div>
      <p className="fg-caption">Loading Forge…</p>
    </div>
  );
}
