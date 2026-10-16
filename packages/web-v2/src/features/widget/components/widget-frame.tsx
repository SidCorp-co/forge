import { WIDGET_SITE_KEY_PATTERN, type WidgetPublicConfig } from "@forge/contracts/widget";
import { Button, IconButton, Spinner } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { type ReactNode, useEffect, useRef } from "react";
import { accentStyle } from "../accent";
import { type HostChannel, useHostChannel } from "../hooks/host";
import { useWidgetConfig } from "../hooks/queries";
import { useVisitorSession } from "../hooks/session";
import { type Shown, shownOf } from "../refusal";
import { Conversation } from "./conversation";
import { RefusalNote } from "./refusal-note";
import { AskVisitor, WaitForSignIn } from "./visitor-gate";

const SITE_UNKNOWN: Shown = { code: "WIDGET_SITE_UNKNOWN", rawCode: "WIDGET_SITE_UNKNOWN", detail: null };

function FrameChrome({
  title,
  accent,
  host,
  focusKey,
  children,
}: {
  title: string;
  accent: string | null;
  host: HostChannel;
  focusKey: string;
  children: ReactNode;
}) {
  const t = useCopy();
  const rootRef = useRef<HTMLDivElement>(null);
  // the page opened the frame, or the step changed under the visitor: focus moves to what they act on
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [host.opened, focusKey]);

  return (
    <div ref={rootRef} className="flex h-dvh flex-col overflow-hidden bg-app text-fg" style={accentStyle(accent)} data-testid="widget-frame">
      <header className="flex flex-none items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <span className="size-2.5 flex-none rounded-full bg-primary" aria-hidden />
        <h1 className="fg-label min-w-0 flex-1 truncate">{title}</h1>
        {host.parentOrigin && (
          <IconButton icon="x" size="sm" aria-label={t("widget.frame.close")} onClick={() => host.tell({ type: "close" })} />
        )}
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      <p className="fg-caption flex-none bg-surface py-1 text-center text-subtle">{t("widget.frame.powered")}</p>
    </div>
  );
}

function Visitor({ siteKey, config, host }: { siteKey: string; config: WidgetPublicConfig; host: HostChannel }) {
  const t = useCopy();
  const session = useVisitorSession(siteKey, config.identity.mode, host);
  const view = session.view;
  const body = (() => {
    switch (view.step) {
      case "opening":
        return (
          <div className="flex flex-1 items-center justify-center" role="status" aria-label={t("widget.frame.loading")}>
            <Spinner size={20} />
          </div>
        );
      case "open":
        return <Conversation token={view.session.sessionToken} config={config} host={host} onEnded={session.end} />;
      case "refused":
        return (
          <div className="flex flex-1 flex-col justify-end p-4">
            <RefusalNote refusal={view.refusal} />
          </div>
        );
      case "wait":
        return view.refusal && host.signed ? (
          <div className="flex flex-1 flex-col justify-end gap-3 p-4">
            <RefusalNote refusal={view.refusal} />
            <Button variant="primary" onClick={() => session.start()} data-autofocus="">
              {t("widget.chat.restart")}
            </Button>
          </div>
        ) : (
          <WaitForSignIn config={config} refusal={view.refusal} />
        );
      case "ask":
        return <AskVisitor config={config} keptEmail={session.keptEmail} refusal={view.refusal} onStart={session.start} />;
    }
  })();
  return (
    <FrameChrome title={config.title} accent={config.accent} host={host} focusKey={view.step}>
      {body}
    </FrameChrome>
  );
}

/**
 * The page the loader's iframe opens: the binding's public config, then who the visitor is, then the
 * conversation. Every refusal is shown by its code, from a site key that is not one onward.
 */
export function WidgetFrame({ siteKey }: { siteKey: string }) {
  const t = useCopy();
  const host = useHostChannel();
  const wellFormed = WIDGET_SITE_KEY_PATTERN.test(siteKey);
  const config = useWidgetConfig(siteKey, wellFormed);
  if (!wellFormed || config.isError)
    return (
      <FrameChrome title={t("widget.meta.frame")} accent={null} host={host} focusKey="refused">
        <div className="flex flex-1 flex-col justify-end p-4">
          <RefusalNote refusal={wellFormed ? shownOf(config.error) : SITE_UNKNOWN} />
        </div>
      </FrameChrome>
    );
  if (!config.data)
    return (
      <FrameChrome title={t("widget.meta.frame")} accent={null} host={host} focusKey="loading">
        <div className="flex flex-1 items-center justify-center" role="status" aria-label={t("widget.frame.loading")}>
          <Spinner size={20} />
        </div>
      </FrameChrome>
    );
  return <Visitor siteKey={siteKey} config={config.data} host={host} />;
}
