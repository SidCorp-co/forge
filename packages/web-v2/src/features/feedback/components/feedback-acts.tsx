// A feedback item's acts, each opened on demand (ISS-903): the page keeps what the item is and what the
// reporter said. The header's one act opens a side sheet holding the assistant's suggested triage, the
// triage form, Confirm the fix, Drop it and Tell the reporter, whichever core's `can` offers; the sheet
// rides the `#feedback-act` anchor, so the triage checklist's Answer link opens it too. Change what it
// is about and Delete reporter data are the palette's (⌘K), each in a sheet of its own.

import { useEffect, useState } from "react";
import { Button, DetailDrawer, usePageCommands } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { useFeedbackAction } from "../hooks";
import type { FeedbackView } from "../types";
import { FeedbackActions, Proposals } from "./feedback-actions";
import { RetargetSheet } from "./feedback-retarget";

/** The anchor the act sheet rides: a link to it opens the sheet. */
export const ACT_ANCHOR = "#feedback-act";

const anchored = () => typeof window !== "undefined" && window.location.hash === ACT_ANCHOR;

function setAnchor(on: boolean) {
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}${on ? ACT_ANCHOR : ""}`);
  // replaceState fires no hashchange: tell the sheet it moved
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Opens the item's act sheet, from the header or anywhere on the page. */
export const openActSheet = () => setAnchor(true);

function useActSheet(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(anchored);
  useEffect(() => {
    const follow = () => setOpen(anchored());
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return [open, setAnchor];
}

/** The words of the item's one act, or null where core offers none the sheet holds. */
export function actLabel(f: FeedbackView, t: ReturnType<typeof useCopy>, language: string): string | null {
  if (f.can.triage || f.can.snooze) return t("feedback.act.triage");
  if (f.can.verify || f.can.reopen || f.can.askVerify) return t("feedback.act.confirmFix");
  if (f.can.drop) return t("feedback.drop.open");
  if (f.can.tellShipped) return said({ key: "feedback.act.tellNow" }, language);
  return null;
}

/** The one primary act the header and the peek offer: it opens the sheet that commits it. */
export function FeedbackPrimary({ f, onAct }: { f: FeedbackView; onAct: () => void }) {
  const t = useCopy();
  const label = actLabel(f, t, useInterfaceLanguage());
  if (!label) return null;
  return (
    <Button type="button" variant="primary" size="sm" onClick={onAct} data-testid="feedback-primary">
      {label}
    </Button>
  );
}

/** What the act sheet holds: the suggested triage first, then the acts core offers. */
export function FeedbackActsBody({ projectId, f }: { projectId: string; f: FeedbackView }) {
  return (
    <section id="feedback-act" data-highlight="triage verify" className="grid gap-6" data-testid="feedback-acts">
      <Proposals projectId={projectId} f={f} />
      <FeedbackActions projectId={projectId} f={f} />
    </section>
  );
}

export function FeedbackActSheet({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const label = actLabel(f, t, useInterfaceLanguage());
  const [open, setOpen] = useActSheet();
  if (!label) return null;
  return (
    <DetailDrawer label={label} trigger={false} open={open} onOpenChange={setOpen} width={560}>
      <FeedbackActsBody projectId={projectId} f={f} />
    </DetailDrawer>
  );
}

function RedactSheet({ projectId, f, open, onOpenChange }: { projectId: string; f: FeedbackView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const redact = () => act.mutate({ kind: "redact" }, { onSuccess: () => onOpenChange(false) });
  return (
    <DetailDrawer label={t("feedback.redact.confirm")} trigger={false} open={open} onOpenChange={onOpenChange}>
      <div className="grid gap-3" data-testid="feedback-redact">
        <p className="text-13">{t("feedback.redact.consequence")}</p>
        <RefusalLine error={act.error} />
        <div>
          <Button type="button" size="sm" variant="danger" loading={act.isPending} onClick={redact}>
            {t("feedback.redact.confirm")}
          </Button>
        </div>
      </div>
    </DetailDrawer>
  );
}

/** Change what it is about and Delete reporter data, named for the palette where core offers them. */
export function FeedbackPaletteActs({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const [side, setSide] = useState<"retarget" | "redact" | null>(null);
  usePageCommands([
    ...(f.can.retarget ? [{ label: t("feedback.retarget.open"), icon: "rename" as const, onRun: () => setSide("retarget") }] : []),
    ...(f.can.redact ? [{ label: t("feedback.redact.open"), icon: "trash" as const, onRun: () => setSide("redact") }] : []),
  ]);
  const shut = (open: boolean) => setSide(open ? side : null);
  return (
    <>
      {f.can.retarget ? <RetargetSheet projectId={projectId} f={f} open={side === "retarget"} onOpenChange={shut} /> : null}
      {f.can.redact ? <RedactSheet projectId={projectId} f={f} open={side === "redact"} onOpenChange={shut} /> : null}
    </>
  );
}
