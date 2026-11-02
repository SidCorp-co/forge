// The acts on a requirement that must say why (defer, drop, undefer, accept by decision): a button that
// opens the reason form in place, or, opened from the page's ⌘K palette, the form alone (ISS-903).

import { useState } from "react";
import { Button, Input, Tooltip, focusOnMount } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRequirementAction } from "../hooks";
import type { RequirementAction } from "../types";

/** The reason an act must give, typed and sent: and, given `extra`, a second optional line beside it. */
export function ReasonForm({
  whyLabel,
  whyHint,
  submit,
  submitVariant,
  extra,
  busy,
  error,
  onSend,
  onCancel,
}: {
  whyLabel: string;
  whyHint: string;
  submit: string;
  submitVariant?: "primary" | "danger";
  extra?: { label: string; hint: string };
  busy: boolean;
  /** The act's refusal, where no caller shows it. */
  error?: unknown;
  onSend: (reason: string, extra: string) => void;
  onCancel: () => void;
}) {
  const t = useCopy();
  const [reason, setReason] = useState("");
  const [more, setMore] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(reason.trim(), more.trim());
      }}
    >
      <Input aria-label={whyLabel} placeholder={whyHint} value={reason} onChange={(e) => setReason(e.target.value)} className="min-w-64 flex-1" ref={focusOnMount} />
      {extra ? <Input aria-label={extra.label} placeholder={extra.hint} value={more} onChange={(e) => setMore(e.target.value)} /> : null}
      <Button type="submit" size="sm" variant={submitVariant} disabled={!reason.trim()} loading={busy}>
        {submit}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      {error ? <RefusalLine error={error} /> : null}
    </form>
  );
}

/** A side act opened from the page's palette rather than a button of its own. */
export interface Held {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** An act that must say why: its button opens the reason form, which sends what `build` makes of it. */
export function ReasonAct({
  projectId,
  reqKey,
  label,
  tip,
  primary = false,
  build,
  held,
  ...form
}: {
  projectId: string;
  reqKey: string;
  label: string;
  tip?: string;
  primary?: boolean;
  build: (reason: string, extra: string) => RequirementAction;
  /** Opened from elsewhere (the page's ⌘K act): no button of its own, the form drawn while open. */
  held?: Held;
} & Pick<Parameters<typeof ReasonForm>[0], "whyLabel" | "whyHint" | "submitVariant" | "extra">) {
  const act = useRequirementAction(projectId, reqKey);
  const [own, setOwn] = useState(false);
  const open = held ? held.open : own;
  const setOpen = held ? held.onOpenChange : setOwn;
  if (held && !open) return null;
  if (open) {
    return (
      <ReasonForm
        {...form}
        submit={label}
        busy={act.isPending}
        error={act.error}
        onSend={(reason, extra) => act.mutate(build(reason, extra), { onSuccess: () => setOpen(false) })}
        onCancel={() => setOpen(false)}
      />
    );
  }
  const button = (
    <Button type="button" size="sm" variant={primary ? "primary" : "ghost"} onClick={() => setOpen(true)}>
      {label}
    </Button>
  );
  return tip ? (
    <Tooltip label={tip} multiline>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/** Accepts over an incomplete acceptance checklist, each unmet item recorded as waived (REQ-74). */
export function AcceptByDecision({ projectId, reqKey, revision, held }: { projectId: string; reqKey: string; revision: number; held?: Held }) {
  const t = useCopy();
  return (
    <ReasonAct
      held={held}
      projectId={projectId}
      reqKey={reqKey}
      label={t("requirements.act.acceptByDecision")}
      whyLabel={t("requirements.act.acceptByDecisionWhyLabel")}
      whyHint={t("requirements.act.acceptByDecisionWhy")}
      build={(reason) => ({ kind: "accept-delivery", revision, reason, byDecision: true })}
    />
  );
}

