// One agreement opened (REQ-90 BC-3, BC-9; design step inspect): its Forge default, the project's exact
// change with its condition, reason, actor and date, the effective rule and where it applies, a conflict's
// two sides, and its history, newest first. In a run's context it leads with the revision the run was
// given. A project admin changes or restores it here; a rule held in settings opens them, and a locked
// guarantee offers nothing.

import type { AgreementDetailView, AgreementRevisionView, AgreementView } from "@forge/contracts/agreements";
import { parseAgreementRevision } from "@forge/contracts/agreements";
import { type ReactNode, useState } from "react";
import { Button, DetailDrawer, Property, PropertyList, Section, StatusChip } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { Link } from "@/lib/navigation/router";
import { useAgreement } from "../hooks";
import { conditionWords, STATE_TONE } from "../view";
import { AgreementEdit, AgreementRestore } from "./agreement-edit";
import { stateLabel } from "./agreement-lanes";

type Act = "change" | "restore" | null;

const revisionOf = (h: AgreementRevisionView) => `${h.layer}@${h.revision}`;

function Rule({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-13-5 text-fg">{text}</p>;
}

function Applies({ words, t }: { words: string | null; t: Copy }) {
  return <Property label={t("agreements.inspect.appliesTo")}>{words ?? t("agreements.always")}</Property>;
}

function History({ history, t }: { history: AgreementRevisionView[]; t: Copy }) {
  const time = useTimeFormat();
  return (
    <ol className="grid gap-3">
      {history.map((h) => (
        <li key={revisionOf(h)} data-testid="history-entry" data-revision={revisionOf(h)} className="grid gap-0.5 border-l-2 border-line pl-3">
          <span className="text-12 text-subtle">
            {[t(`agreements.layer.${h.layer}` as ProductCopyKey), t(`agreements.change.${h.change}` as ProductCopyKey), h.actor?.name, time.date(h.at)].filter(Boolean).join(" · ")}
          </span>
          {h.rule ? <span className="text-13 text-fg">{h.rule}</span> : null}
          {h.reason ? <span className="text-12 text-muted">{h.reason}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** The run's revision, read from the agreement's history: what that run was told. */
function ReceivedRule({ d, received, t }: { d: AgreementDetailView; received: string; t: Copy }) {
  const at = parseAgreementRevision(received);
  const h = at ? d.history.find((x) => x.layer === at.layer && x.revision === at.revision) : undefined;
  return (
    <Section title={t("agreements.inspect.received")} testId="inspect-received">
      {h?.rule ? <Rule text={h.rule} /> : null}
      <PropertyList>
        {at ? <Property label={t("agreements.inspect.source")}>{t(`agreements.layer.${at.layer}` as ProductCopyKey)}</Property> : null}
        <Applies words={conditionWords(h?.condition ?? null)} t={t} />
      </PropertyList>
    </Section>
  );
}

function Layers({ d, t }: { d: AgreementDetailView; t: Copy }) {
  const time = useTimeFormat();
  return (
    <>
      <Section title={t("agreements.inspect.effective")} testId="inspect-effective">
        <Rule text={d.effective.rule} />
        <PropertyList>
          <Applies words={conditionWords(d.effective.condition)} t={t} />
        </PropertyList>
      </Section>
      {d.conflict ? (
        <Section title={t("agreements.inspect.conflict")} testId="inspect-conflict">
          <p className="text-13 text-fg">{d.conflict.says}</p>
          <Rule text={d.conflict.forge.rule} />
        </Section>
      ) : null}
      {d.project ? (
        <Section title={t("agreements.inspect.project")} testId="inspect-project">
          <Rule text={d.project.rule} />
          <PropertyList>
            <Applies words={conditionWords(d.project.condition)} t={t} />
            <Property label={t("agreements.inspect.reason")}>{d.project.reason}</Property>
            <Property label={t("agreements.inspect.by")}>{d.project.actor.name ?? "—"}</Property>
            <Property label={t("agreements.inspect.when")}>{time.date(d.project.at)}</Property>
          </PropertyList>
        </Section>
      ) : null}
      {d.forge ? (
        <Section title={t("agreements.inspect.forge")} testId="inspect-forge">
          <Rule text={d.forge.rule} />
          {d.forge.detail ? <p className="mt-2 whitespace-pre-wrap text-13 text-muted">{d.forge.detail}</p> : null}
          <PropertyList>
            <Property label={t("agreements.inspect.source")}>{d.forge.source}</Property>
            {d.forge.restates.length ? <Property label={t("agreements.inspect.restates")}>{d.forge.restates.map((l) => l.title).join("; ")}</Property> : null}
          </PropertyList>
        </Section>
      ) : null}
    </>
  );
}

/** What a reader may do with the agreement: nothing on a locked guarantee, settings where they hold it, change and restore for an admin. */
function Acts({ a, slug, canManage, act, setAct, t }: { a: AgreementView; slug: string; canManage: boolean; act: Act; setAct: (a: Act) => void; t: Copy }) {
  if (a.locked) return <StatusChip tone="blocked" label={t("agreements.locked")} value="locked" />;
  if (a.authority !== "agreement")
    return (
      <Link href={`/projects/${slug}/settings`} className="text-13 font-medium text-link hover:underline">
        {t("agreements.act.openSettings")}
      </Link>
    );
  if (!canManage || act) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="primary" onClick={() => setAct("change")}>
        {t("agreements.act.change")}
      </Button>
      {a.project ? (
        <Button type="button" size="sm" onClick={() => setAct("restore")}>
          {a.state === "project_only" ? t("agreements.act.retire") : t("agreements.act.restore")}
        </Button>
      ) : null}
    </div>
  );
}

function Body({ d, projectId, slug, canManage, received, t }: { d: AgreementDetailView; projectId: string; slug: string; canManage: boolean; received: string | null; t: Copy }) {
  const [act, setAct] = useState<Act>(null);
  let form: ReactNode = null;
  if (act === "change") form = <AgreementEdit projectId={projectId} a={d} onDone={() => setAct(null)} />;
  if (act === "restore") form = <AgreementRestore projectId={projectId} a={d} onDone={() => setAct(null)} />;
  return (
    <div className="grid gap-1" data-testid="agreement-inspector">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <StatusChip tone={STATE_TONE[d.state]} label={stateLabel(d, t)} value={d.state} />
        <span className="flex-1" />
        <Acts a={d} slug={slug} canManage={canManage} act={act} setAct={setAct} t={t} />
      </div>
      {form ? <div className="border-t border-line-divider py-4">{form}</div> : null}
      {received ? <ReceivedRule d={d} received={received} t={t} /> : null}
      <Layers d={d} t={t} />
      <Section title={t("agreements.inspect.history")} testId="inspect-history">
        <History history={d.history} t={t} />
      </Section>
    </div>
  );
}

export function AgreementInspector({
  projectId,
  slug,
  open,
  name,
  canManage,
  received,
  onClose,
}: {
  projectId: string;
  slug: string;
  open: string | null;
  name: string;
  canManage: boolean;
  received: string | null;
  onClose: () => void;
}) {
  const t = useCopy();
  const q = useAgreement(projectId, open);
  return (
    <DetailDrawer label={name} trigger={false} open={open !== null} onOpenChange={(o) => (o ? undefined : onClose())} width={520} testId="agreement-drawer">
      {open ? (
        <QueryBoundary query={q} loadingLabel={t("agreements.loading")} height="inline">
          {(d) => <Body key={d.slug} d={d} projectId={projectId} slug={slug} canManage={canManage} received={received} t={t} />}
        </QueryBoundary>
      ) : null}
    </DetailDrawer>
  );
}
