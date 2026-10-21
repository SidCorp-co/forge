import { mockupKindOfFile } from "@forge/contracts/mockups";
import { useRef, useState } from "react";
import { AcceptStep, ActorChip, Button, EnumBadge, Input, StatusBadge, ViewHeading } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { SketchPad } from "@/features/chat";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { fileBase64, targetInput } from "../api";
import { useMockupAct, useMockups, useOpenMockup, useProposeMockup } from "../hooks";
import type { MockupTarget, MockupView } from "../types";
import { MockupPreview } from "./mockup-preview";
import { ReviseMockup } from "./mockup-revise";
import { MockupViewer } from "./mockup-viewer";

/** Whose words a mockup's reason is: the accept's or the return's. */
const REASON_LEAD: Partial<Record<MockupView["status"], ProductCopyKey>> = { accepted: "common.mockups.acceptedLead", returned: "common.mockups.returnedLead" };

/** Where a mockup stands among its revisions and comments, in one line. */
function RevisionStanding({ m }: { m: MockupView }) {
  const t = useCopy();
  const facts = [
    m.round > 1 && m.revises ? t("common.mockups.revisesLine", { n: m.round, key: m.revises }) : null,
    m.revisedBy ? t("common.mockups.revisedByLine", { key: m.revisedBy }) : null,
    m.comments.total ? t("common.mockups.commentsLine", { open: m.comments.open, total: m.comments.total }) : null,
  ].filter(Boolean);
  if (!facts.length) return null;
  return (
    <p className="text-12 text-muted" data-testid="mockup-revision-facts">
      {facts.join(" · ")}
    </p>
  );
}

function Decide({ projectId, m }: { projectId: string; m: MockupView }) {
  const act = useMockupAct(projectId);
  const [returning, setReturning] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  const busy = act.isPending;
  const t = useCopy();
  if (!m.can.accept && !m.can.return && !m.can.withdraw) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {m.can.accept ? (
        <Button type="button" size="sm" variant="primary" disabled={busy || accepting} aria-expanded={accepting} onClick={() => setAccepting(true)}>
          {t("common.mockups.accept")}
        </Button>
      ) : null}
      {m.can.return && !returning ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => setReturning(true)}>
          {t("common.mockups.return")}
        </Button>
      ) : null}
      {returning ? (
        <>
          <Input aria-label={t("common.mockups.why")} placeholder={t("common.mockups.why")} value={reason} onChange={(e) => setReason(e.target.value)} className="w-72 max-sm:w-full" />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!reason.trim()}
            loading={busy}
            onClick={() => act.mutate({ key: m.key, act: "return", reason }, { onSuccess: () => setReturning(false) })}
          >
            {t("common.mockups.returnIt")}
          </Button>
        </>
      ) : null}
      {m.can.withdraw ? (
        <Button type="button" size="sm" variant="ghost" loading={busy} onClick={() => act.mutate({ key: m.key, act: "withdraw" })}>
          {t("common.mockups.withdraw")}
        </Button>
      ) : null}
      {accepting ? (
        <div className="basis-full">
          <AcceptStep
            confirmLabel={t("common.mockups.accept")}
            consequence={t(m.target.type === "requirement" ? "common.mockups.acceptRequirement" : "common.mockups.acceptItem")}
            loading={busy}
            onCancel={() => setAccepting(false)}
            onConfirm={(why) => act.mutate({ key: m.key, act: "accept", reason: why }, { onSuccess: () => setAccepting(false) })}
          />
        </div>
      ) : null}
      <RefusalLine error={act.error} />
    </div>
  );
}

function Row({
  projectId,
  m,
  onOpen,
  subject,
  onClear,
}: {
  projectId: string;
  m: MockupView;
  onOpen: () => void;
  /** The chat beside the page is about this mockup. */
  subject: boolean;
  onClear: () => void;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  const [revising, setRevising] = useState(false);
  const lead = REASON_LEAD[m.status];
  return (
    <li className="grid gap-2 border-b border-line-subtle py-4" data-testid="mockup-row" data-key={m.key}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-13">
        <span className="font-semibold text-fg">{m.caption ?? m.name}</span>
        <EnumBadge family="mockupKind" value={m.kind} />
        <StatusBadge family="mockup" value={m.status} />
        {m.round > 1 ? <span className="text-12 text-muted">{t("common.mockups.round", { n: m.round })}</span> : null}
        {m.pinned ? <span className="text-12 text-muted">{t("common.mockups.pinnedIn", { r: m.pinned.revision })}</span> : null}
        <span className="ml-auto inline-flex items-center gap-2 text-13 text-muted">
          <ActorChip name={m.proposedByName ?? t("standing.who.itsAuthor")} kind={m.proposedAgency} size={16} />
          <span title={`${m.key} · ${m.name}${m.target.revision ? ` · ${t("common.mockups.against", { r: m.target.revision })}` : ""} · ${time.dateTime(m.createdAt)}`}>
            {time.relative(m.createdAt)}
          </span>
        </span>
      </div>
      {m.reason ? (
        <p className="text-13 text-muted">
          {lead ? t(lead) : ""}
          {m.reason}
        </p>
      ) : null}
      <RevisionStanding m={m} />
      <MockupPreview url={m.url} kind={m.kind} name={m.name} onOpen={onOpen} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onOpen} data-testid="mockup-open">
          {m.can.comment ? t("common.mockups.openComment") : t("common.mockups.fullScreen")}
        </Button>
        {subject ? (
          <span className="inline-flex items-center gap-2 text-12 text-muted" data-testid="mockup-subject">
            {t("common.mockups.chatAbout")}
            <button type="button" className="text-accent-text hover:underline" onClick={onClear}>
              {t("common.mockups.chatAboutClear")}
            </button>
          </span>
        ) : null}
        {m.can.revise && !revising ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setRevising(true)} data-testid="mockup-revise-open">
            {t("common.mockups.reviseOpen")}
          </Button>
        ) : null}
      </div>
      <Decide projectId={projectId} m={m} />
      {revising ? <ReviseMockup projectId={projectId} m={m} onDone={() => setRevising(false)} /> : null}
    </li>
  );
}

/** Proposes a mockup on the item: an upload (an HTML page, an image, a board, an example) or a sketch. */
export function ProposeMockup({ projectId, target, label }: { projectId: string; target: MockupTarget; label?: string }) {
  const propose = useProposeMockup(projectId);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [sketching, setSketching] = useState(false);
  const t = useCopy();
  const send = async (file: File, kind: MockupView["kind"]) => {
    propose.mutate(
      {
        target: targetInput(target),
        kind,
        name: file.name,
        ...(file.type ? { mime: file.type } : {}),
        ...(caption.trim() ? { caption: caption.trim() } : {}),
        contentBase64: await fileBase64(file),
      },
      { onSuccess: () => setCaption("") },
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="mockup-propose">
      <Input aria-label={t("common.mockups.caption")} placeholder={t("common.mockups.captionPlaceholder")} value={caption} onChange={(e) => setCaption(e.target.value)} className="w-56 max-sm:w-full" />
      <input
        ref={pickerRef}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.html,.htm,.json,.txt,.http"
        data-testid="mockup-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void send(file, mockupKindOfFile(file.name, file.type));
        }}
      />
      <Button type="button" size="sm" variant="secondary" loading={propose.isPending} onClick={() => pickerRef.current?.click()} data-testid="mockup-add">
        {label ?? t("common.mockups.upload")}
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setSketching(true)}>
        {t("shell.composer.sketch")}
      </Button>
      {sketching ? <SketchPad open onClose={() => setSketching(false)} onAttach={(file) => void send(file, "sketch")} /> : null}
      <RefusalLine error={propose.error} />
    </div>
  );
}

/** The mockup `?mockup=MK-n&full=1` names, open full screen over its item's page while it is one of `rows`. */
export function MockupViewerHost({ projectId, slug, rows }: { projectId: string; slug: string; rows: readonly MockupView[] }) {
  const view = useOpenMockup();
  if (!view.full || !view.subject || !rows.some((r) => r.key === view.subject)) return null;
  return <MockupViewer projectId={projectId} slug={slug} rows={rows} shown={view.subject} onShow={view.open} onClose={view.close} />;
}

/**
 * The mockups of a requirement, a feedback item or an issue (REQ-49): each runs inline and opens full
 * screen, where it is commented on and pinned; a returned one is proposed again as its next revision.
 * Who may act and what is pinned are core's. `hostViewer` is false where another part of the page
 * already hosts the full-screen view.
 */
export function MockupList({
  projectId,
  slug,
  target,
  canPropose = true,
  hostViewer = true,
}: {
  projectId: string;
  slug: string;
  target: MockupTarget;
  canPropose?: boolean;
  hostViewer?: boolean;
}) {
  const q = useMockups(projectId, target);
  const view = useOpenMockup();
  const rows = q.data?.mockups ?? [];
  const t = useCopy();
  return (
    <section data-testid="view-mockups" aria-label={t("common.mockups.title")}>
      <ViewHeading right={canPropose ? <ProposeMockup projectId={projectId} target={target} /> : undefined}>{t("common.mockups.title")}</ViewHeading>
      {q.isError ? <p className="text-13 text-muted">{formatApiError(q.error)}</p> : null}
      {q.isSuccess && rows.length === 0 ? <p className="text-13 text-subtle">{t("common.mockups.none")}</p> : null}
      {rows.length ? (
        <ul className="border-t border-line-subtle" data-testid="mockup-list">
          {rows.map((m) => (
            <Row key={m.id} projectId={projectId} m={m} onOpen={() => view.open(m.key)} subject={view.subject === m.key && !view.full} onClear={() => view.close()} />
          ))}
        </ul>
      ) : null}
      {hostViewer ? <MockupViewerHost projectId={projectId} slug={slug} rows={rows} /> : null}
    </section>
  );
}
