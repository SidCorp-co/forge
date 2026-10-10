"use client";

// An assistant's turn as the thread draws it: its prose and blocks, the corrections it took, and the note where a reply replaced its draft.

import { Icon } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { Conversation } from "@/features/session";
import { type MessageEntry, parseMessages } from "@/features/session";
import { type Correction, withoutCorrections } from "../corrections";


export function AssistantTurn({
  entry,
  streaming,
  newestAgentId,
}: {
  entry: MessageEntry;
  streaming?: boolean;
  /** The thread's newest assistant turn — every turn above it folds its machinery (ISS-1083). */
  newestAgentId?: string;
}) {
  const { entry: prose, corrections } = withoutCorrections(entry);
  const items = parseMessages([prose]);
  if (items.length === 0 && corrections.length === 0) return null;
  return (
    <>
      {items.length > 0 && (
        <Conversation
          items={items}
          readOnly
          streaming={streaming}
          {...(newestAgentId ? { newestAgentId } : {})}
        />
      )}
      {corrections.map((c) => (
        <CorrectionLine key={c.line} correction={c} />
      ))}
    </>
  );
}

function CorrectionLine({ correction }: { correction: Correction }) {
  const t = useCopy();
  return (
    <div
      role="alert"
      data-testid="thread-correction"
      className="flex items-start gap-2 border-l-2 border-danger-9 bg-danger-2 px-3 py-2"
    >
      <Icon name="alert" size={15} className="mt-0.5 flex-none text-danger" />
      <p className="fg-body-sm text-fg">
        <span className="font-semibold">{t("shell.thread.correction")}</span> {t("shell.thread.refused", { what: correction.what })} (
        <span className="font-mono">{correction.code}</span>){t("shell.thread.writtenNothing")}
      </p>
    </div>
  );
}

/**
 * The one trace a replaced draft leaves: a line saying it was replaced, and by which rule. The
 * draft's words are not here, because nobody in the room is shown what the reply check withdrew.
 */
export function ReplacedDraftNote() {
  const t = useCopy();
  return (
    <p className="fg-caption flex items-start gap-2 text-subtle" data-testid="thread-reply-withdrawn">
      <Icon name="alert" size={13} className="mt-0.5 flex-none" />
      <span>{t("shell.thread.withdrawn")}</span>
    </p>
  );
}
