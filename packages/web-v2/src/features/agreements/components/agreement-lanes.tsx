// The current rules as aligned lanes (REQ-90 BC-1, BC-9): each agreement's Forge default, the project's
// change and what agents get, side by side, so an override and its result read without opening it. A
// lane that is the effective rule's own source shows a mark, never the rule twice; the rule it replaced
// reads struck. Each row's name opens the inspector.

import type { AgreementView } from "@forge/contracts/agreements";
import type { ReactNode } from "react";
import { GroupHeader, Icon, type ListGroup, TBody, TD, TH, THead, TR, Table, StatusChip, type useGroupFold } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { conditionWords, STATE_TONE } from "../view";

export type Fold = ReturnType<typeof useGroupFold>;

/** One line of a lane, cut at the cell's edge; the whole rule is its tooltip and the inspector's. */
function LaneText({ text, struck = false }: { text: string; struck?: boolean }) {
  return (
    <span className={cn("block truncate", struck ? "text-subtle line-through decoration-neutral-8" : "text-fg")} title={text}>
      {text}
    </span>
  );
}

/** This lane is where the effective rule comes from: an arrow toward it, its words for a screen reader. */
function SameMark({ t }: { t: Copy }) {
  return (
    <span data-same="" className="inline-flex items-center text-subtle">
      <Icon name="arrowRight" size={14} />
      <span className="sr-only">{t("agreements.same")}</span>
    </span>
  );
}

function ConditionChip({ words }: { words: string }) {
  return <span className="ml-1.5 inline-flex flex-none rounded-sm bg-sunken px-1.5 text-11-5 font-medium text-muted">{words}</span>;
}

function forgeLane(a: AgreementView, t: Copy): ReactNode {
  if (!a.forge) return null;
  if (a.effective.from === "forge") return <SameMark t={t} />;
  return <LaneText text={a.conflict ? a.conflict.forge.rule : a.forge.rule} struck={a.state !== "conflict"} />;
}

function projectLane(a: AgreementView, t: Copy): ReactNode {
  if (!a.project) return null;
  const words = conditionWords(a.project.condition);
  return (
    <span className="flex min-w-0 items-center">
      {a.effective.from === "project" ? <SameMark t={t} /> : <LaneText text={a.project.rule} />}
      {words ? <ConditionChip words={words} /> : null}
    </span>
  );
}

export function AgreementName({ a, onOpen, t }: { a: AgreementView; onOpen: (slug: string) => void; t: Copy }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <button type="button" onClick={() => onOpen(a.slug)} className="truncate text-left font-medium text-fg hover:underline focus-visible:shadow-focus">
        {a.name}
      </button>
      {a.locked ? (
        <span role="img" aria-label={t("agreements.locked")} title={t("agreements.locked")} className="inline-flex flex-none text-subtle">
          <Icon name="lock" size={13} />
        </span>
      ) : null}
    </span>
  );
}

export const stateLabel = (a: AgreementView, t: Copy) => t(`agreements.state.${a.state}` as ProductCopyKey);

function AgreementInLanes({ a, selected, onOpen, t }: { a: AgreementView; selected: boolean; onOpen: (slug: string) => void; t: Copy }) {
  return (
    <TR data-testid="agreement-row" data-name={a.name} aria-selected={selected || undefined} className={cn(selected && "bg-sel")}>
      <TD className="w-56 max-w-56 pl-8">
        <AgreementName a={a} onOpen={onOpen} t={t} />
      </TD>
      <TD className="max-w-60 max-md:hidden" data-testid="lane-forge">
        {forgeLane(a, t)}
      </TD>
      <TD className="max-w-56 max-md:hidden" data-testid="lane-project">
        {projectLane(a, t)}
      </TD>
      <TD className="max-w-80" data-testid="lane-effective">
        <LaneText text={a.effective.rule} />
      </TD>
      <TD className="w-28 whitespace-nowrap">
        <span data-testid="agreement-state">
          <StatusChip tone={STATE_TONE[a.state]} label={stateLabel(a, t)} value={a.state} />
        </span>
      </TD>
    </TR>
  );
}

/** A group's header across the table's columns: the shared hierarchy, folded on click. */
export function GroupInTable<R>({ g, fold, span }: { g: ListGroup<R>; fold: Fold; span: number }) {
  return (
    <tr>
      <td colSpan={span} className="p-0">
        <GroupHeader id={g.id} label={g.label} count={g.rows.length} tone={g.tone} open={fold.isOpen(g.id, g.collapsed)} onToggle={() => fold.toggle(g.id, g.collapsed)} />
      </td>
    </tr>
  );
}

export function AgreementLanes({ groups, fold, selected, onOpen }: { groups: ListGroup<AgreementView>[]; fold: Fold; selected: string | null; onOpen: (slug: string) => void }) {
  const t = useCopy();
  return (
    <Table aria-label={t("agreements.title")} className="table-fixed">
      <THead>
        <TR>
          <TH className="w-56 pl-8">{t("agreements.col.agreement")}</TH>
          <TH className="max-md:hidden">{t("agreements.col.forge")}</TH>
          <TH className="max-md:hidden">{t("agreements.col.project")}</TH>
          <TH>{t("agreements.col.effective")}</TH>
          <TH className="w-28">{t("agreements.col.state")}</TH>
        </TR>
      </THead>
      <TBody>
        {groups.map((g) => (
          <LaneGroup key={g.id} g={g} fold={fold} selected={selected} onOpen={onOpen} t={t} />
        ))}
      </TBody>
    </Table>
  );
}

function LaneGroup({ g, fold, selected, onOpen, t }: { g: ListGroup<AgreementView>; fold: Fold; selected: string | null; onOpen: (slug: string) => void; t: Copy }) {
  return (
    <>
      <GroupInTable g={g} fold={fold} span={5} />
      {fold.isOpen(g.id, g.collapsed) ? g.rows.map((a) => <AgreementInLanes key={a.slug} a={a} selected={selected === a.slug} onOpen={onOpen} t={t} />) : null}
    </>
  );
}
