import type { ReleaseLanding } from "@forge/contracts/releases";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";

// The landings a project with no production environment records as its releases: each names the
// branch and commit its issues landed at, and never reads as a deploy, since nothing was deployed.

export function ReleaseLandings({ landings }: { landings: readonly ReleaseLanding[] }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (landings.length === 0) return null;
  return (
    <section aria-label={t("releases.landings.title")} data-testid="release-landings" className="grid gap-2 px-5 py-4">
      <h2 className="text-12 font-medium uppercase tracking-wide text-subtle">{t("releases.landings.title")}</h2>
      <ol className="divide-y divide-line-subtle border-y border-line-subtle">
        {landings.map((l) => (
          <li key={l.runId} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 text-13" data-testid="release-landing">
            <span className="min-w-0 flex-1">{t("releases.landing", { branch: l.branch, sha: l.commit.slice(0, 7) })}</span>
            <span className="font-mono text-12 text-muted">{l.issues.join(", ")}</span>
            <span className="text-12 text-muted" title={time.dateTime(l.at)}>
              {time.relative(l.at)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
