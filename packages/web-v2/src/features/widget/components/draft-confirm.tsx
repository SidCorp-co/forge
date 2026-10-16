import type { WidgetFeedbackDraft, WidgetFiled } from "@forge/contracts/widget";
import { Badge, Button, Kicker } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import type { Shown } from "../refusal";
import { FiledLink } from "./filed-link";
import { RefusalNote } from "./refusal-note";

function Said({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-12 font-semibold text-muted">{label}</dt>
      <dd className="text-13 whitespace-pre-line text-fg">{text}</dd>
    </div>
  );
}

const kindKey = (kind: WidgetFeedbackDraft["kind"]): ProductCopyKey => `widget.draft.kind.${kind}`;

/**
 * What the assistant proposes to file, for the visitor to send or discard: the title and what they
 * did, saw and expected, in their own words as the assistant summed them up. Once sent it gives way
 * to the status link; once discarded it folds to one line.
 */
export function DraftConfirm({
  draft,
  filed,
  busy,
  refusal,
  onSend,
  onDiscard,
}: {
  draft: WidgetFeedbackDraft;
  filed: WidgetFiled | null;
  busy: "send" | "discard" | null;
  refusal: Shown | null;
  onSend: () => void;
  onDiscard: () => void;
}) {
  const t = useCopy();
  if (draft.state === "discarded")
    return (
      <p className="fg-caption self-center text-subtle" data-testid="widget-draft" data-state="discarded">
        {t("widget.draft.discarded")} · {draft.title}
      </p>
    );
  if (draft.state === "filed") return <FiledLink title={draft.title} filed={filed} />;
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-line-strong bg-surface p-3"
      aria-label={t("widget.draft.kicker")}
      data-testid="widget-draft"
      data-state="pending"
    >
      <div className="flex items-center justify-between gap-2">
        <Kicker>{t("widget.draft.kicker")}</Kicker>
        <Badge>{t(kindKey(draft.kind))}</Badge>
      </div>
      <h3 className="fg-label text-fg">{draft.title}</h3>
      <dl className="flex flex-col gap-2">
        <Said label={t("widget.draft.did")} text={draft.did} />
        <Said label={t("widget.draft.saw")} text={draft.saw} />
        <Said label={t("widget.draft.expected")} text={draft.expected} />
        <Said label={t("widget.draft.where")} text={draft.whereSeen} />
      </dl>
      {refusal && <RefusalNote refusal={refusal} />}
      <div className="flex gap-2">
        <Button variant="primary" onClick={onSend} loading={busy === "send"} disabled={busy !== null}>
          {t("widget.draft.send")}
        </Button>
        <Button variant="secondary" onClick={onDiscard} loading={busy === "discard"} disabled={busy !== null}>
          {t("widget.draft.discard")}
        </Button>
      </div>
    </section>
  );
}
