/* The app's route-level loading fallback. It lives under `(workspace)` and not
   at `src/app/`, where it used to sit, because a root `loading.tsx` is an
   ancestor Suspense boundary for EVERY route: the shell streams before the page
   has awaited anything, which commits HTTP 200, and a `notFound()` raised after
   that renders the 404 page under a 200 status. Measured on the standalone
   server (ISS-1124): `/guides/<unknown>` answered 200 with the boundary at the
   root and 404 with it here. Anything public added outside this group inherits
   that, so put a new boundary next to the routes that want one. */
import { ColdBoot } from "@/design/patterns/mascot-loaders";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app">
      <ColdBoot />
    </div>
  );
}
