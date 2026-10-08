"use client";

import { mockupKindOfFile } from "@forge/contracts/mockups";
import { parseWireframe } from "@forge/contracts/wireframe";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { AcceptStep, ActorChip, Button, EnumBadge, Input, StatusBadge, ViewHeading } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { SketchPad } from "@/features/chat/components/sketch/sketch-pad";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { fileBase64, targetInput } from "../api";
import { useMockupAct, useMockupBytes, useMockups, useProposeMockup } from "../hooks";
import type { MockupTarget, MockupView } from "../types";

function OpeningBoard() {
  const t = useCopy();
  return <p className="p-4 text-13 text-muted">{t("common.mockups.openingBoard")}</p>;
}

const BoardCanvas = dynamic(() => import("@/features/board/board-canvas"), {
  ssr: false,
  loading: () => <OpeningBoard />,
});

function useObjectUrl(blob: Blob | undefined) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url;
}

function Preview({ m }: { m: MockupView }) {
  const [open, setOpen] = useState(m.kind === "image" || m.kind === "sketch");
  const t = useCopy();
  const q = useMockupBytes(m.url, open);
  const url = useObjectUrl(q.data);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data || m.kind === "image" || m.kind === "sketch") return;
    q.data.text().then(setText);
  }, [q.data, m.kind]);
  const parsed = useMemo(() => {
    if (m.kind !== "wireframe" || text === null) return null;
    try {
      return parseWireframe(JSON.parse(text));
    } catch {
      return null;
    }
  }, [m.kind, text]);
  if (!open) {
    return (
      <button type="button" className="w-fit text-13 font-medium text-accent-text hover:underline" onClick={() => setOpen(true)}>
        {m.kind === "wireframe" ? t("common.mockups.openBoard") : m.kind === "html" ? t("common.mockups.previewPage") : t("common.mockups.showExample")}
      </button>
    );
  }
  if (q.isError) return <p className="text-13 text-muted">{formatApiError(q.error)}</p>;
  if (m.kind === "image" || m.kind === "sketch") {
    if (!url) return <p className="text-13 text-muted">{t("common.mockups.loading")}</p>;
    // biome-ignore lint/performance/noImgElement: a blob URL of a stored mockup with no known intrinsic size; `next/image` cannot optimise it
    return <img src={url} alt={m.caption ?? m.name} className="max-h-[420px] max-w-full border border-line-subtle object-contain" data-testid="mockup-image" />;
  }
  if (text === null) return <p className="text-13 text-muted">{t("common.mockups.loading")}</p>;
  if (m.kind === "wireframe") {
    if (!parsed?.ok) return <p className="text-13 text-muted">{t("common.mockups.unreadable")}</p>;
    return (
      <div className="h-[420px] border border-line-subtle" data-testid="mockup-board">
        <BoardCanvas doc={parsed.doc} />
      </div>
    );
  }
  if (m.kind === "html") {
    return <iframe title={m.name} sandbox="" srcDoc={text} className="h-[420px] w-full border border-line-subtle bg-white" data-testid="mockup-html" />;
  }
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    shown = text;
  }
  return <pre className="max-h-[420px] overflow-auto bg-sunken p-3 font-mono text-12 leading-relaxed">{shown}</pre>;
}

/** Whose words a mockup's reason is: the accept's or the return's. */
const REASON_LEAD: Partial<Record<MockupView["status"], ProductCopyKey>> = { accepted: "common.mockups.acceptedLead", returned: "common.mockups.returnedLead" };

function Row({ projectId, m }: { projectId: string; m: MockupView }) {
  const act = useMockupAct(projectId);
  const [returning, setReturning] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  const busy = act.isPending;
  const t = useCopy();
  const time = useTimeFormat();
  const lead = REASON_LEAD[m.status];
  return (
    <li className="grid gap-2 border-b border-line-subtle py-4" data-testid="mockup-row" data-key={m.key}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-13">
        <span className="font-semibold text-fg">{m.caption ?? m.name}</span>
        <EnumBadge family="mockupKind" value={m.kind} />
        <StatusBadge family="mockup" value={m.status} />
        {m.pinned ? <span className="text-12 text-muted">{t("common.mockups.pinnedIn", { r: m.pinned.revision })}</span> : null}
        <span className="ml-auto inline-flex items-center gap-2 text-12-5 text-muted">
          <ActorChip name={m.proposedByName ?? t("standing.who.itsAuthor")} kind={m.proposedAgency} size={16} />
          <span title={`${m.key} · ${m.name}${m.target.revision ? ` · ${t("common.mockups.against", { r: m.target.revision })}` : ""} · ${time.dateTime(m.createdAt)}`}>
            {time.relative(m.createdAt)}
          </span>
        </span>
      </div>
      {m.reason ? <p className="text-13 text-muted">{lead ? t(lead) : ""}{m.reason}</p> : null}
      <Preview m={m} />
      {m.can.accept || m.can.return || m.can.withdraw ? (
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
              <Input aria-label={t("common.mockups.why")} placeholder={t("common.mockups.why")} value={reason} onChange={(e) => setReason(e.target.value)} className="w-72" />
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
                consequence={m.target.type === "requirement" ? t("common.mockups.acceptRequirement") : t("common.mockups.acceptItem")}
                loading={busy}
                onCancel={() => setAccepting(false)}
                onConfirm={(why) => act.mutate({ key: m.key, act: "accept", reason: why }, { onSuccess: () => setAccepting(false) })}
              />
            </div>
          ) : null}
          <RefusalLine error={act.error} />
        </div>
      ) : null}
    </li>
  );
}

function Propose({ projectId, target }: { projectId: string; target: MockupTarget }) {
  const propose = useProposeMockup(projectId);
  const picker = useRef<HTMLInputElement>(null);
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
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={t("common.mockups.caption")} placeholder={t("common.mockups.captionPlaceholder")} value={caption} onChange={(e) => setCaption(e.target.value)} className="w-56" />
      <input
        ref={picker}
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
      <Button type="button" size="sm" variant="secondary" loading={propose.isPending} onClick={() => picker.current?.click()}>
        {t("common.mockups.upload")}
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setSketching(true)}>
        {t("shell.composer.sketch")}
      </Button>
      {sketching ? <SketchPad open onClose={() => setSketching(false)} onAttach={(file) => void send(file, "sketch")} /> : null}
      <RefusalLine error={propose.error} />
    </div>
  );
}

/** The Mockups tab of a requirement, a feedback item or an issue; who may act and what is pinned are core's. */
export function MockupsPanel({ projectId, target, canPropose = true }: { projectId: string; target: MockupTarget; canPropose?: boolean }) {
  const q = useMockups(projectId, target);
  const rows = q.data?.mockups ?? [];
  const t = useCopy();
  return (
    <section data-testid="view-mockups" aria-label={t("common.mockups.title")}>
      <ViewHeading right={canPropose ? <Propose projectId={projectId} target={target} /> : undefined}>{t("common.mockups.title")}</ViewHeading>
      <p className="mb-3 max-w-[80ch] text-13 text-muted">
        {target.type === "requirement" ? t("common.mockups.leadRequirement", { r: target.revision }) : t("common.mockups.leadItem")}
      </p>
      {q.isError ? <p className="text-13 text-muted">{formatApiError(q.error)}</p> : null}
      {q.isSuccess && rows.length === 0 ? <p className="text-13 text-subtle">{t("common.mockups.none")}</p> : null}
      {rows.length ? (
        <ul className="border-t border-line-subtle" data-testid="mockup-list">
          {rows.map((m) => (
            <Row key={m.id} projectId={projectId} m={m} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
