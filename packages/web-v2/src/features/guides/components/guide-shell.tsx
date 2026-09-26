import Link from "next/link";
import { coreFileUrl } from "@/lib/utils/core-url";
import { INDEX_PATH } from "../corpus";

/** Chrome for the public documentation. Deliberately not the workspace shell:
 *  these routes are read by people with no Forge account and by agents with no
 *  credential, so nothing here reads a session. */
export function GuideShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-app">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-5 sm:px-6">
          <Link href={INDEX_PATH} className="fg-h3 font-semibold text-fg">
            Forge documentation
          </Link>
          <span className="fg-caption text-subtle">
            For people using Forge, people connecting an assistant, and agents.
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-12 sm:px-6">
        <p className="fg-caption break-words text-subtle">
          The pages for agents and scripts are also markdown an agent can fetch without a credential:{" "}
          <code className="break-all font-mono">{coreFileUrl("/api/guides")}</code> for the index and{" "}
          <code className="break-all font-mono">{coreFileUrl("/api/guides")}/&lt;slug&gt;.md</code> for one
          page.
        </p>
      </footer>
    </div>
  );
}
