// One environment read as a person reads it: its address, what kind it is, which branch it runs, how
// it goes live, the services it calls, which test accounts a run signs in with, and what is live on it
// now. The fields that change it open under an Edit act; the raw document is under Advanced.
import { Property, PropertyList, StatusBadge } from "@/design";
import { Link } from "@/lib/navigation/router";
import type { EnvironmentState, ProbeOutcome } from "@/features/project-config";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { settingsHref } from "../sections";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function probeLine(p: ProbeOutcome, t: Copy): string {
  switch (p.status) {
    case "confirmed":
      return t("settings.project.raw.probeServes", { observed: p.observed });
    case "mismatch":
      return t("settings.project.raw.probeMismatch", { observed: p.observed, expected: p.expected });
    case "uncompared":
      return `${t("settings.project.raw.probeServes", { observed: p.observed })}; ${p.error}`;
    case "unreachable":
      return p.error;
  }
}

/** What runs on the environment now, in one line: tracked and which revision, or why it is not known. */
function LiveNow({ live }: { live: EnvironmentState | null | undefined }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (live === undefined) return <span className="text-muted">{t("settings.project.env.reading")}</span>;
  if (live === null) return <span className="text-muted">{t("settings.project.env.noReading")}</span>;
  if (live.state === "unknown") {
    const said = live.reason.cause === "external" ? t("settings.project.env.liveOutside") : live.reason.cause === "no-record" ? t("settings.project.env.liveNoRecord") : t("settings.project.env.liveUnread");
    return <span className="text-muted">{said}</span>;
  }
  if (live.state === "serving") {
    return <span>{t("settings.project.raw.probeServes", { observed: live.source.revision.slice(0, 8) })}</span>;
  }
  const revision = live.source.kind === "revision" ? live.source.revision.slice(0, 8) : null;
  const probe = live.probes?.[0];
  return (
    <>
      <StatusBadge family="deployment" value={live.state} />
      <span>{revision ? t("settings.project.env.liveRevision", { revision, at: time.date(live.deployment.at) }) : time.date(live.deployment.at)}</span>
      {probe ? <span className="text-muted">· {probeLine(probe, t)}</span> : null}
    </>
  );
}

export function EnvironmentSummary({
  slug,
  env,
  defaultBranch,
  deployLabel,
  live,
  accounts,
}: {
  slug: string;
  env: Obj;
  defaultBranch: string;
  /** The deploy connection's name, or null where it goes live outside Forge. */
  deployLabel: string | null;
  live: EnvironmentState | null | undefined;
  /** The test accounts the environment's profile names, or null where it names none. */
  accounts: { profile: string; names: string[] } | null;
}) {
  const t = useCopy();
  const url = str(env.url);
  const services = Object.entries(obj(env.services)).map(([name, u]) => ({ name, url: str(u) }));
  const trigger = str(obj(env.deployment).trigger);
  return (
    <PropertyList testId="environment-summary">
      <Property label={t("settings.project.delivery.url")}>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="font-mono text-link hover:underline" translate="no">
            {url.replace(/^https:\/\//, "")}
          </a>
        ) : (
          <span className="text-muted">{t("settings.project.env.notSet")}</span>
        )}
      </Property>
      <Property label={t("settings.project.delivery.tierLabel")}>{t(`settings.project.delivery.tier.${str(env.tier) || "dev"}` as ProductCopyKey)}</Property>
      <Property label={t("settings.project.env.runs")}>
        <span className="font-mono" translate="no">
          {str(env.deploysFrom) || defaultBranch || "—"}
        </span>
      </Property>
      <Property label={t("settings.project.delivery.deployBy")}>
        {deployLabel === null ? t("settings.project.env.outside") : trigger ? t("settings.project.env.byConnection", { connection: deployLabel, when: t(`settings.project.env.when.${trigger}` as ProductCopyKey) }) : deployLabel}
      </Property>
      <Property label={t("settings.project.env.services")}>
        {services.length === 0 ? (
          <span className="text-muted">{t("settings.project.env.none")}</span>
        ) : (
          services.map((s) => (
            <span key={s.name} className="mr-3" translate="no">
              <span className="font-medium">{s.name}</span> <span className="font-mono text-muted">{s.url.replace(/^https:\/\//, "")}</span>
            </span>
          ))
        )}
      </Property>
      <Property label={t("settings.project.env.testAccounts")}>
        {accounts === null ? (
          <span className="text-muted">{t("settings.project.env.none")}</span>
        ) : (
          <Link href={settingsHref(slug, "testing", `profile-${accounts.profile}`)} className="text-link hover:underline">
            {accounts.names.length > 0 ? accounts.names.join(", ") : t("settings.project.env.profileNamed", { profile: accounts.profile })}
          </Link>
        )}
      </Property>
      <Property label={t("settings.project.env.liveNow")}>
        <LiveNow live={live} />
      </Property>
    </PropertyList>
  );
}
