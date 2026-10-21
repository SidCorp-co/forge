import { mockupKindOfFile } from "@forge/contracts/mockups";
import { useRef, useState } from "react";
import { Button, Input, NativeSelect } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { fileBase64 } from "../api";
import { useMockupComments, useProposeMockup } from "../hooks";
import type { MockupView } from "../types";
import { pinWords } from "./mockup-comments";

type Settle = "open" | "answered" | "resolved";

/**
 * Proposes a returned mockup again as its next revision (REQ-49 BC-3): its new file, and for each
 * comment still open on it or a revision before it, whether this revision answers it, resolves it
 * with a note, or leaves it open. A resolve says why; core refuses one that does not.
 */
export function ReviseMockup({ projectId, m, onDone }: { projectId: string; m: MockupView; onDone: () => void }) {
  const t = useCopy();
  const propose = useProposeMockup(projectId);
  const comments = useMockupComments(projectId, m.key);
  const open = (comments.data?.comments ?? []).filter((c) => !c.settled);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [settle, setSettle] = useState<Record<string, Settle>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const choice = (id: string): Settle => settle[id] ?? "answered";
  const send = async () => {
    if (!file) return;
    const picked = (s: Settle) => open.filter((c) => choice(c.id) === s);
    propose.mutate(
      {
        revises: m.key,
        kind: mockupKindOfFile(file.name, file.type),
        name: file.name,
        ...(file.type ? { mime: file.type } : {}),
        ...(m.caption ? { caption: m.caption } : {}),
        contentBase64: await fileBase64(file),
        answers: picked("answered").map((c) => ({ comment: c.id, ...(notes[c.id]?.trim() ? { note: notes[c.id]?.trim() } : {}) })),
        resolves: picked("resolved").map((c) => ({ comment: c.id, note: notes[c.id]?.trim() ?? "" })),
      },
      { onSuccess: onDone },
    );
  };
  return (
    <div className="grid gap-3 border-t border-line-subtle pt-3" data-testid="mockup-revise">
      <p className="text-13 font-semibold text-fg">{t("common.mockups.reviseTitle", { key: m.key })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={pickerRef}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.html,.htm,.json,.txt,.http"
          data-testid="mockup-revise-file"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        <Button type="button" size="sm" variant="secondary" onClick={() => pickerRef.current?.click()}>
          {t("common.mockups.reviseFile")}
        </Button>
        <span className="text-13 text-muted">{file?.name ?? t("common.mockups.reviseNoFile")}</span>
      </div>
      {open.length ? (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle" data-testid="mockup-revise-comments">
          {open.map((c) => (
            <li key={c.id} className="grid gap-1.5 py-2 sm:grid-cols-3 sm:items-center">
              <span className="text-13 text-fg sm:col-span-1">
                {c.body}
                <span className="block text-12 text-subtle">{pinWords(c.pin, t)}</span>
              </span>
              <NativeSelect
                aria-label={t("common.mockups.reviseSettle", { body: c.body })}
                value={choice(c.id)}
                onChange={(e) => setSettle((s) => ({ ...s, [c.id]: e.target.value as Settle }))}
                options={[
                  { value: "answered", label: t("common.mockups.settleAnswered") },
                  { value: "resolved", label: t("common.mockups.settleResolved") },
                  { value: "open", label: t("common.mockups.settleOpen") },
                ]}
              />
              <Input
                aria-label={t("common.mockups.reviseNote")}
                placeholder={choice(c.id) === "resolved" ? t("common.mockups.reviseWhy") : t("common.mockups.reviseNote")}
                value={notes[c.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))}
                disabled={choice(c.id) === "open"}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="primary" disabled={!file} loading={propose.isPending} onClick={() => void send()}>
          {t("common.mockups.reviseSend")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <RefusalLine error={propose.error} />
      </div>
    </div>
  );
}
