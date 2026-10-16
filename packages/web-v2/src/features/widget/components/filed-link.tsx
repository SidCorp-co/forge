import type { WidgetFiled } from "@forge/contracts/widget";
import { Button, Icon } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useState } from "react";

/** The status link as an address a person can open from anywhere: core's, resolved against the web origin. */
export function absoluteLink(statusUrl: string): string {
  try {
    return new URL(statusUrl, window.location.origin).href;
  } catch {
    return statusUrl;
  }
}

/**
 * A sent report: thanks, the reference, and the private status link the visitor keeps to follow it,
 * with a way to copy it. Where the link is not known (the history of an earlier page), the report
 * reads sent without one.
 */
export function FiledLink({ title, filed }: { title: string; filed: WidgetFiled | null }) {
  const t = useCopy();
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const link = filed ? absoluteLink(filed.statusUrl) : null;

  function copy() {
    if (!link) return;
    if (!navigator.clipboard) {
      setCopied("failed");
      return;
    }
    navigator.clipboard.writeText(link).then(
      () => setCopied("yes"),
      () => setCopied("failed"),
    );
  }

  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-ok-9 bg-surface p-3"
      aria-label={t("widget.filed.title")}
      data-testid="widget-filed"
    >
      <p className="text-13 flex items-center gap-2 font-semibold text-ok-11">
        <Icon name="check" size={16} />
        {t("widget.filed.title")}
      </p>
      <p className="text-13 text-fg">{title}</p>
      {filed && <p className="text-12 font-mono text-muted">{t("widget.filed.ref", { key: filed.feedbackKey })}</p>}
      {link && (
        <>
          <p className="fg-body-sm text-muted">{t("widget.filed.keep")}</p>
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-13 break-all rounded-sm bg-sunken px-2 py-1.5 font-mono text-link underline-offset-2 hover:underline"
            data-testid="widget-status-link"
          >
            {link}
          </a>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" icon={copied === "yes" ? "check" : "link"} onClick={copy}>
              {copied === "yes" ? t("widget.filed.copied") : t("widget.filed.copy")}
            </Button>
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-13 inline-flex items-center gap-1 px-2 font-semibold text-link hover:underline"
            >
              {t("widget.filed.open")}
              <Icon name="arrowRight" size={14} />
            </a>
          </div>
          {copied === "failed" && (
            <p className="fg-caption text-danger" role="alert">
              {t("widget.filed.copyFailed")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
