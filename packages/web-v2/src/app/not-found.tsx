import Link from "next/link";
import { ForgeMascot } from "@/design";

/**
 * Global 404. Renders OUTSIDE the (workspace) shell, so it is fully
 * self-contained (own centering + app background). `next/link` auto-prefixes
 * the basePath; web-v2 serves at root (ISS-397) so Home resolves to `/`.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-app px-6 py-12 text-center">
      <ForgeMascot size={120} mode="blink" ring={false} progress={0.4} />
      <div>
        <p className="fg-h2">Page not found</p>
        <p className="fg-body-sm mx-auto mt-1.5 max-w-[320px]">
          This page moved or never existed. Let&rsquo;s get you back on track.
        </p>
      </div>
      <Link
        href="/"
        className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-[13.5px] font-semibold text-[color:var(--fg-on-accent)] transition-colors hover:bg-[color:var(--accent-hover)]"
      >
        Back to home
      </Link>
    </div>
  );
}
