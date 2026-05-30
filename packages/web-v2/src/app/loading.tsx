import { ColdBoot } from "@/design/patterns/mascot-loaders";

/* Root Suspense fallback — shown while an async route segment streams.
   The mascot-forward cold-boot splash, not a bare spinner. */
export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app">
      <ColdBoot />
    </div>
  );
}
