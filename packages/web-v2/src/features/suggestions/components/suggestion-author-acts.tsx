// What a suggestion's author may do with their own while it waits: revise it, which proposes the
// payload as it should read and withdraws the original (core keeps the new one naming the old), or
// withdraw it. Only its author is offered these; anyone else decides it with Accept and Reject.

import type { QueryKey } from "@tanstack/react-query";
import { useState } from "react";
import { Button, ConfirmDialog, Disclosure, Field, Input, Textarea, sentenceCase } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useSuggestionAuthorAct } from "../hooks";
import type { SuggestionView } from "../types";

type Payload = Record<string, unknown>;

const isPayload = (p: unknown): p is Payload => typeof p === "object" && p !== null && !Array.isArray(p);

/** The payload's own words: each top-level field that holds text, in the order the payload keeps them. */
export const wordFields = (payload: unknown): string[] =>
  isPayload(payload) ? Object.keys(payload).filter((k) => typeof payload[k] === "string") : [];

/** A payload field's name as a label: `changeSummary` reads "Change summary". */
export const fieldLabel = (field: string) => sentenceCase(field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());

/** The original payload with its words as the person typed them. */
const withWords = (original: unknown, words: Record<string, string>): unknown => (isPayload(original) ? { ...original, ...words } : original);

/** The payload a revise sends: the whole of it as typed where the person opened every field, else the original with its words changed. */
export function revisedPayload(original: unknown, words: Record<string, string>, all: string | null): { ok: true; payload: unknown } | { ok: false } {
  if (all === null) return { ok: true, payload: withWords(original, words) };
  try {
    return { ok: true, payload: JSON.parse(all) };
  } catch {
    return { ok: false };
  }
}

function ReviseForm({ s, busy, onSend, onCancel }: { s: SuggestionView; busy: boolean; onSend: (payload: unknown, reason: string) => void; onCancel: () => void }) {
  const t = useCopy();
  const fields = wordFields(s.payload);
  const [words, setWords] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f, String((s.payload as Payload)[f])])));
  const [all, setAll] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [badJson, setBadJson] = useState(false);
  return (
    <form
      className="grid gap-2"
      data-testid="suggestion-revise"
      onSubmit={(e) => {
        e.preventDefault();
        const next = revisedPayload(s.payload, words, all);
        setBadJson(!next.ok);
        if (next.ok) onSend(next.payload, reason.trim());
      }}
    >
      {all === null
        ? fields.map((f) => (
            <Field key={f} label={f === "tldr" ? t("requirements.revise.summary") : fieldLabel(f)}>
              <Textarea rows={2} value={words[f] ?? ""} onChange={(e) => setWords((w) => ({ ...w, [f]: e.target.value }))} />
            </Field>
          ))
        : null}
      <Disclosure
        title={t("requirements.suggestion.reviseAll")}
        open={all !== null}
        onOpenChange={(open) => setAll(open ? JSON.stringify(withWords(s.payload, words), null, 2) : null)}
        testId="suggestion-revise-fold"
      >
        <Textarea rows={10} className="font-mono text-12" value={all ?? ""} onChange={(e) => setAll(e.target.value)} aria-label={t("requirements.suggestion.reviseAll")} data-testid="suggestion-revise-all" />
        {badJson ? (
          <p className="text-12 text-danger" role="alert">
            {t("requirements.suggestion.reviseJsonInvalid")}
          </p>
        ) : null}
      </Disclosure>
      <span className="flex flex-wrap items-center gap-2">
        <Input aria-label={t("requirements.suggestion.reviseWhy")} placeholder={t("requirements.suggestion.reviseWhy")} value={reason} onChange={(e) => setReason(e.target.value)} className="min-w-64 flex-1" />
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          {t("requirements.suggestion.reviseSave")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </span>
    </form>
  );
}

export function SuggestionAuthorActs({ projectId, s, affected, busy: deciding }: { projectId: string; s: SuggestionView; affected: readonly QueryKey[]; busy: boolean }) {
  const t = useCopy();
  const act = useSuggestionAuthorAct(projectId, affected);
  const [step, setStep] = useState<"revise" | "withdraw" | null>(null);
  const busy = deciding || act.isPending;
  const closed = { onSuccess: () => setStep(null) };
  return (
    <>
      <span className="text-12 font-semibold text-muted" data-testid="suggestion-yours">
        {t("requirements.suggestion.yours")}
      </span>
      <Button type="button" size="sm" variant="ghost" disabled={busy || step !== null} aria-expanded={step === "revise"} onClick={() => setStep("revise")} data-testid="suggestion-revise-open">
        {t("requirements.suggestion.revise")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy || step !== null} onClick={() => setStep("withdraw")} data-testid="suggestion-withdraw">
        {t("requirements.suggestion.withdraw")}
      </Button>
      {step === "revise" ? (
        <div className="basis-full">
          <ReviseForm s={s} busy={act.isPending} onCancel={() => setStep(null)} onSend={(payload, reason) => act.mutate({ kind: "revise", id: s.id, payload, reason }, closed)} />
        </div>
      ) : null}
      <ConfirmDialog
        open={step === "withdraw"}
        title={t("requirements.suggestion.withdraw")}
        message={t("requirements.suggestion.withdrawConfirm")}
        confirmLabel={t("requirements.suggestion.withdraw")}
        tone="danger"
        loading={act.isPending}
        onConfirm={() => act.mutate({ kind: "withdraw", id: s.id }, closed)}
        onClose={() => setStep(null)}
      />
      {act.error ? (
        <div className="basis-full">
          <RefusalLine error={act.error} />
        </div>
      ) : null}
    </>
  );
}
