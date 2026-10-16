// One record waiting on the viewer's approve-type decision: what it is, who asked, how long it has
// waited, and its acts. Approve opens a confirm step saying what it does (taking the reason the route
// keeps, where it keeps one); Decline opens the reason its asker will read; Open goes to the record's
// own page. Every press posts the row's own body to the route that page calls, as the viewer.

import { useState } from "react";
import { AcceptStep, Button, MonoTag, RowItem, sentenceCase, useNow } from "@/design";
import { RejectStep } from "@/features/suggestions";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { formatElapsed } from "@/lib/utils/format";
import { usePressApproval } from "../hooks";
import { approvalOpensHref } from "../routes";
import type { ApprovalItem, ApprovalUnreadable } from "../types";

type Step = "approve" | "decline" | null;

/** Who asked, in the reader's words: a person, an agent, or the assistant answering a person. */
function useAsker(item: ApprovalItem): string {
  const t = useCopy();
  const a = item.askedBy;
  if (!a) return t("approvals.askedBy.unknown");
  if (!a.name) return t(`approvals.askedBy.${a.kind}Gone`);
  return t(`approvals.askedBy.${a.kind}`, { name: a.name });
}

/** What the row is called where its asker wrote no title: its kind and the record it is on. */
function useTitle(item: ApprovalItem): string {
  const t = useCopy();
  if (item.title) return item.title;
  return t(`approvals.untitled.${item.kind}`, { key: item.key });
}

function Waited({ since }: { since: string }) {
  const t = useCopy();
  const now = useNow(60_000);
  return <span>{t("approvals.waiting", { age: formatElapsed(now - Date.parse(since)) })}</span>;
}

export function ApprovalEntry({ item, slug }: { item: ApprovalItem; slug: string }) {
  const t = useCopy();
  const press = usePressApproval();
  const [step, setStep] = useState<Step>(null);
  const asker = useAsker(item);
  const title = useTitle(item);
  const href = approvalOpensHref(slug, item.opens);
  const busy = press.isPending;
  const closed = { onSuccess: () => setStep(null) };
  const detail = item.suggestionKind ?? item.mockupKind;
  return (
    <RowItem
      testId="approval-entry"
      rowKey={item.id}
      wrap
      title={title}
      facts={[
        // After the title, not before it: keys differ in width, and a lead column of them staggers every title.
        <MonoTag key="key">{item.key}</MonoTag>,
        <span key="kind" className="text-fg">
          {t(`approvals.kind.${item.kind}`)}
          {item.revision ? ` · r${item.revision}` : ""}
          {detail ? ` · ${sentenceCase(detail)}` : ""}
        </span>,
      ]}
      note={
        <span data-testid="approval-asked">
          {asker}
          {item.since ? (
            <>
              <span className="mx-1.5 text-neutral-8">·</span>
              <Waited since={item.since} />
            </>
          ) : null}
        </span>
      }
      trailing={
        <>
          {item.approve ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={busy || step !== null}
              aria-expanded={step === "approve"}
              onClick={() => setStep("approve")}
              data-testid="approval-approve"
            >
              {t("approvals.act.approve")}
            </Button>
          ) : (
            <span className="text-12 text-muted">{t("approvals.onItsPage")}</span>
          )}
          {item.decline ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || step !== null}
              aria-expanded={step === "decline"}
              onClick={() => setStep("decline")}
              data-testid="approval-decline"
            >
              {t("approvals.act.decline")}
            </Button>
          ) : null}
          {href ? (
            <Link href={href} className="text-12-5 font-semibold text-link underline-offset-2 hover:underline" data-testid="approval-open">
              {t("approvals.act.open")}
            </Link>
          ) : null}
        </>
      }
    >
      {step === "approve" && item.approve ? (
        item.approve.reason === "none" ? (
          <span className="flex flex-wrap items-center gap-2" data-testid="approval-confirm">
            <span className="text-12 text-muted">{t(`approvals.consequence.${item.kind}`, { key: item.key, r: item.revision ?? "" })}</span>
            <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => item.approve && press.mutate({ act: item.approve }, closed)}>
              {t("approvals.act.approve")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setStep(null)}>
              {t("common.cancel")}
            </Button>
          </span>
        ) : (
          <AcceptStep
            confirmLabel={t("approvals.act.approve")}
            consequence={t(`approvals.consequence.${item.kind}`, { key: item.key, r: item.revision ?? "" })}
            reasonRequired={item.approve.reason === "required"}
            loading={busy}
            onCancel={() => setStep(null)}
            onConfirm={(why) => item.approve && press.mutate({ act: item.approve, reason: why }, closed)}
          />
        )
      ) : null}
      {step === "decline" && item.decline ? (
        <RejectStep
          loading={busy}
          label={t("approvals.act.decline")}
          reasonLabel={t("approvals.declineWhy")}
          onCancel={() => setStep(null)}
          onConfirm={(why) => item.decline && press.mutate({ act: item.decline, reason: why }, closed)}
        />
      ) : null}
      {press.error ? <RefusalLine error={press.error} /> : null}
    </RowItem>
  );
}

/**
 * A pending record core could not make a row of: named, with what broke, and opened on its own page,
 * where it is decided. It is never dropped from the list, and never the reason the list fails.
 */
export function UnreadableEntry({ entry, slug }: { entry: ApprovalUnreadable; slug: string }) {
  const t = useCopy();
  const href = approvalOpensHref(slug, entry.opens);
  return (
    <RowItem
      testId="approval-unreadable"
      rowKey={entry.id}
      wrap
      title={t("approvals.unreadable.title", { kind: t(`approvals.kind.${entry.kind}`), key: entry.key })}
      facts={[<MonoTag key="key">{entry.key}</MonoTag>]}
      note={<span data-testid="approval-unreadable-problem">{t("approvals.unreadable.problem", { problem: entry.problem })}</span>}
      trailing={
        href ? (
          <Link href={href} className="text-12-5 font-semibold text-link underline-offset-2 hover:underline" data-testid="approval-open">
            {t("approvals.act.open")}
          </Link>
        ) : null
      }
    />
  );
}
