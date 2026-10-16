import { Banner } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ReactNode } from "react";
import { refusalKey, type Shown } from "../refusal";

/** A refusal in the visitor's words: its plain sentence, core's detail for a limit, and the code to quote. */
export function RefusalNote({ refusal, action }: { refusal: Shown; action?: ReactNode }) {
  const t = useCopy();
  return (
    <div className="flex flex-col gap-1" data-testid="widget-refusal" data-code={refusal.rawCode ?? refusal.code}>
      <Banner tone={refusal.code === "WIDGET_LIMIT_REACHED" ? "attention" : "danger"} action={action}>
        {t(refusalKey(refusal.code))}
      </Banner>
      {refusal.detail && <p className="fg-body-sm pl-3 text-muted">{refusal.detail}</p>}
      {refusal.rawCode && (
        <p className="text-12 pl-3 font-mono text-subtle" translate="no">
          {t("widget.refused.code", { code: refusal.rawCode })}
        </p>
      )}
    </div>
  );
}
