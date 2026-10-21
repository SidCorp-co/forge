import { useState } from "react";
import { Button, Textarea, focusOnMount } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

/** A lesson's one sentence, edited in place under the lesson or the confusion it settles. */
export function SentenceEditor({
  initial,
  label,
  loading = false,
  onSave,
  onCancel,
}: {
  initial: string;
  /** The confirming button, named as the act ("Save", "Save and approve"). */
  label: string;
  loading?: boolean;
  onSave: (sentence: string) => void;
  onCancel: () => void;
}) {
  const t = useCopy();
  const [sentence, setSentence] = useState(initial);
  const said = sentence.trim();
  return (
    <form
      className="grid grid-cols-1 gap-2"
      data-testid="lesson-sentence-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (said) onSave(said);
      }}
    >
      <Textarea
        aria-label={t("lessons.sentence")}
        rows={2}
        value={sentence}
        onChange={(e) => setSentence(e.target.value)}
        ref={focusOnMount}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!said} loading={loading}>
          {label}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
