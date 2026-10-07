"use client";

import { mockupKindOfFile } from "@forge/contracts/mockups";
import { parseWireframe } from "@forge/contracts/wireframe";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { AcceptStep, ActorChip, Button, EnumBadge, Input, StatusBadge, ViewHeading } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { SketchPad } from "@/features/chat/components/sketch/sketch-pad";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { fileBase64, targetInput } from "../api";
import { useMockupAct, useMockupBytes, useMockups, useProposeMockup } from "../hooks";
import type { MockupTarget, MockupView } from "../types";

const BoardCanvas = dynamic(() => import("@/features/board/board-canvas"), {
  ssr: false,
  loading: () => <p className="p-4 text-13 text-muted">Opening the board…</p>,
});

function useObjectUrl(blob: Blob | undefined) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url;
}

function Preview({ m }: { m: MockupView }) {
  const [open, setOpen] = useState(m.kind === "image" || m.kind === "sketch");
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
        {m.kind === "wireframe" ? "Open the board" : m.kind === "html" ? "Preview the page" : "Show the example"}
      </button>
    );
  }
  if (q.isError) return <p className="text-13 text-muted">{formatApiError(q.error)}</p>;
  if (m.kind === "image" || m.kind === "sketch") {
    if (!url) return <p className="text-13 text-muted">Loading…</p>;
    // biome-ignore lint/performance/noImgElement: a blob URL of a stored mockup with no known intrinsic size; `next/image` cannot optimise it
    return <img src={url} alt={m.caption ?? m.name} className="max-h-[420px] max-w-full border border-line-subtle object-contain" data-testid="mockup-image" />;
  }
  if (text === null) return <p className="text-13 text-muted">Loading…</p>;
  if (m.kind === "wireframe") {
    if (!parsed?.ok) return <p className="text-13 text-muted">The board could not be read as wireframe-v1.</p>;
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
const REASON_LEAD: Partial<Record<MockupView["status"], string>> = { accepted: "Accepted: ", returned: "Returned: " };

function Row({ projectId, m }: { projectId: string; m: MockupView }) {
  const act = useMockupAct(projectId);
  const [returning, setReturning] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  const busy = act.isPending;
  return (
    <li className="grid gap-2 border-b border-line-subtle py-4" data-testid="mockup-row" data-key={m.key}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-13">
        <span className="font-semibold text-fg">{m.caption ?? m.name}</span>
        <EnumBadge family="mockupKind" value={m.kind} />
        <StatusBadge family="mockup" value={m.status} />
        {m.pinned ? <span className="text-12 text-muted">Pinned in r{m.pinned.revision}</span> : null}
        <span className="ml-auto inline-flex items-center gap-2 text-12-5 text-muted">
          <ActorChip name={m.proposedByName ?? "Its author"} kind={m.proposedAgency} size={16} />
          <span title={`${m.key} · ${m.name}${m.target.revision ? ` · against r${m.target.revision}` : ""} · ${formatStamp(m.createdAt)}`}>
            {formatRelativeTime(m.createdAt)}
          </span>
        </span>
      </div>
      {m.reason ? <p className="text-13 text-muted">{REASON_LEAD[m.status] ?? ""}{m.reason}</p> : null}
      <Preview m={m} />
      {m.can.accept || m.can.return || m.can.withdraw ? (
        <div className="flex flex-wrap items-center gap-2">
          {m.can.accept ? (
            <Button type="button" size="sm" variant="primary" disabled={busy} aria-expanded={accepting} onClick={() => setAccepting((v) => !v)}>
              Accept
            </Button>
          ) : null}
          {m.can.return && !returning ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setReturning(true)}>
              Return
            </Button>
          ) : null}
          {returning ? (
            <>
              <Input aria-label="Why it goes back" placeholder="Why it goes back" value={reason} onChange={(e) => setReason(e.target.value)} className="w-72" />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!reason.trim()}
                loading={busy}
                onClick={() => act.mutate({ key: m.key, act: "return", reason }, { onSuccess: () => setReturning(false) })}
              >
                Return it
              </Button>
            </>
          ) : null}
          {m.can.withdraw ? (
            <Button type="button" size="sm" variant="ghost" loading={busy} onClick={() => act.mutate({ key: m.key, act: "withdraw" })}>
              Withdraw
            </Button>
          ) : null}
          {accepting ? (
            <div className="basis-full">
              <AcceptStep
                confirmLabel="Accept"
                consequence={
                  m.target.type === "requirement"
                    ? "Accepting lets the next agree or re-pin pin it beside the designs."
                    : "Accepting gives it to the runs on this item."
                }
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
      <Input aria-label="Caption" placeholder="Caption (optional)" value={caption} onChange={(e) => setCaption(e.target.value)} className="w-56" />
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
        Upload
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setSketching(true)}>
        Sketch
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
  return (
    <section data-testid="view-mockups" aria-label="Mockups">
      <ViewHeading right={canPropose ? <Propose projectId={projectId} target={target} /> : undefined}>Mockups</ViewHeading>
      <p className="mb-3 max-w-[80ch] text-13 text-muted">
        {target.type === "requirement"
          ? `A proposal is made against r${target.revision}. Once a person other than its author accepts it, the next agree or re-pin pins it beside the designs, and every run on an issue of this requirement is given it.`
          : "A wireframe, a sketch, a screenshot, an HTML page or an API example of what this should look like. A person other than its author accepts it, and runs on this item are given what was accepted."}
      </p>
      {q.isError ? <p className="text-13 text-muted">{formatApiError(q.error)}</p> : null}
      {q.isSuccess && rows.length === 0 ? <p className="text-13 text-subtle">No mockup proposed yet.</p> : null}
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
