import Link from "next/link";
import { coreFileUrl } from "@/lib/utils/core-url";

/** Chrome for the public guide pages. Deliberately not the workspace shell:
 *  these routes are read by people with no Forge account and by agents with no
 *  credential, so nothing here reads a session. */
export function GuideShell({
  children,
  back,
}: {
  children: React.ReactNode;
  back?: boolean;
}) {
  return (
    <div className="min-h-dvh bg-app">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-[72ch] flex-wrap items-baseline gap-x-3 gap-y-1 px-6 py-5">
          <Link href="/guides" className="fg-h3 font-semibold text-fg">
            Forge guides
          </Link>
          <span className="fg-caption text-subtle">
            How Forge works, in the words its agents are held to.
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-[72ch] px-6 py-8">
        {back ? (
          <Link href="/guides" className="fg-caption mb-6 inline-block text-subtle hover:text-muted">
            &larr; All guides
          </Link>
        ) : null}
        {children}
      </main>
      <footer className="mx-auto max-w-[72ch] px-6 pb-12">
        <p className="fg-caption text-subtle">
          The same text, as markdown an agent can fetch without a credential:{" "}
          <code className="font-mono">{coreFileUrl("/api/guides")}</code> for the index and{" "}
          <code className="font-mono">{coreFileUrl("/api/guides")}/&lt;slug&gt;.md</code> for one
          guide.
        </p>
      </footer>
    </div>
  );
}
