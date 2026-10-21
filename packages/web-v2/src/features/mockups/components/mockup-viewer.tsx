import { useState } from "react";
import { Button, Dialog, EnumBadge, Icon, MediaOverlay, showToast, StatusBadge } from "@/design";
import { useChatDock } from "@/features/chat-dock";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useMockupFeedbackForm } from "../feedback-slot";
import { useMockupComments } from "../hooks";
import type { MockupPin, MockupView } from "../types";
import { CommentComposer, CommentList, PinLayer } from "./mockup-comments";
import { MockupBody } from "./mockup-preview";

/** The revisions `m` belongs to, first proposal first, read off the rows its item lists (REQ-49 BC-3). */
export function revisionsOf(m: MockupView, rows: readonly MockupView[]): MockupView[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const chain = [m];
  for (let back = m.revises ? byKey.get(m.revises) : undefined; back && !chain.includes(back); back = back.revises ? byKey.get(back.revises) : undefined)
    chain.unshift(back);
  for (let next = m.revisedBy ? byKey.get(m.revisedBy) : undefined; next && !chain.includes(next); next = next.revisedBy ? byKey.get(next.revisedBy) : undefined)
    chain.push(next);
  return chain;
}

/** Each revision of one mockup, earlier ones readable beside the one shown. */
export function RevisionList({ chain, shown, onShow }: { chain: readonly MockupView[]; shown: string; onShow: (key: string) => void }) {
  const t = useCopy();
  if (chain.length < 2) return null;
  return (
    <nav aria-label={t("common.mockups.revisions")} className="flex flex-wrap items-center gap-1" data-testid="mockup-revisions">
      {chain.map((r) => (
        <button
          key={r.key}
          type="button"
          aria-current={r.key === shown ? "true" : undefined}
          onClick={() => onShow(r.key)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-12 focus-visible:shadow-focus focus-visible:outline-none",
            r.key === shown ? "border-accent bg-sel text-fg" : "border-line-subtle text-muted hover:bg-hover",
          )}
          data-testid="mockup-revision"
          data-key={r.key}
        >
          <span className="font-semibold">{t("common.mockups.round", { n: r.round })}</span>
          <span>{r.key}</span>
          <StatusBadge family="mockup" value={r.status} />
        </button>
      ))}
    </nav>
  );
}

function FeedbackAbout({ projectId, slug, m, onClose }: { projectId: string; slug: string; m: MockupView; onClose: () => void }) {
  const t = useCopy();
  const form = useMockupFeedbackForm();
  if (!form) return null;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())} title={t("common.mockups.feedbackTitle", { key: m.key })} width="lg" testId="mockup-feedback">
      {form({
        projectId,
        slug,
        mockupKey: m.key,
        onDone: (key) => {
          showToast({ title: t("common.mockups.feedbackFiled", { key, mockup: m.key }) });
          onClose();
        },
      })}
    </Dialog>
  );
}

/**
 * A mockup open full screen (REQ-49 BC-1, BC-2, BC-3, BC-4): it runs at the size of the screen, its
 * comments beside it with their marks on the frame, a comment pinned by pressing or dragging on it,
 * its revisions one press apart, and the chat and feedback about it one press away.
 */
export function MockupViewer({
  projectId,
  slug,
  rows,
  shown,
  onShow,
  onClose,
}: {
  projectId: string;
  slug: string;
  rows: readonly MockupView[];
  shown: string;
  onShow: (key: string) => void;
  /** `keep` leaves the mockup what the page is about, as a chat about it needs. */
  onClose: (keep?: boolean) => void;
}) {
  const t = useCopy();
  const dock = useChatDock();
  const canFile = useMockupFeedbackForm() !== null;
  const m = rows.find((r) => r.key === shown);
  const comments = useMockupComments(projectId, shown, Boolean(m));
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<MockupPin | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  if (!m) return null;
  const thread = comments.data?.comments ?? [];
  // a mark is drawn on the frame it was made on; earlier revisions' comments are listed, not drawn
  const marks = thread.map((c) => (c.on === m.key ? c : { ...c, pin: null }));
  return (
    <MediaOverlay open onOpenChange={(o) => (o ? undefined : onClose())} label={t("common.mockups.viewerLabel", { key: m.key, name: m.name })}>
      <div className="flex h-full min-h-0 flex-col bg-surface text-fg" data-testid="mockup-viewer" data-key={m.key}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2">
          <span className="font-mono text-12 text-muted">{m.key}</span>
          <span className="min-w-0 truncate text-14 font-semibold">{m.caption ?? m.name}</span>
          <EnumBadge family="mockupKind" value={m.kind} />
          <StatusBadge family="mockup" value={m.status} />
          <RevisionList chain={revisionsOf(m, rows)} shown={m.key} onShow={onShow} />
          <span className="ml-auto flex items-center gap-2">
            {dock?.projectId ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  onClose(true);
                  dock.askAbout(null);
                }}
                data-testid="mockup-ask"
              >
                <Icon name="chat" size={15} />
                {t("common.mockups.ask")}
              </Button>
            ) : null}
            {canFile ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => setFiling(true)} data-testid="mockup-feedback-open">
                {t("common.mockups.feedback")}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => onClose()} aria-label={t("common.close")} data-testid="mockup-close">
              <Icon name="x" size={16} />
            </Button>
          </span>
        </header>
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <div className="relative min-h-0 flex-1 bg-sunken max-md:basis-3/5" data-testid="mockup-stage">
            <MockupBody url={m.url} kind={m.kind} name={m.name} />
            <PinLayer
              comments={marks}
              active={active}
              picking={picking}
              draft={draft}
              onPick={(pin) => {
                setDraft(pin);
                setPicking(false);
              }}
            />
          </div>
          <aside className="flex min-h-0 w-96 flex-col border-l border-line max-md:w-full max-md:basis-2/5 max-md:border-t max-md:border-l-0" aria-label={t("common.mockups.comments")}>
            <h2 className="border-b border-line-subtle px-4 py-2 text-13 font-semibold">
              {t("common.mockups.commentsCount", { open: comments.data?.open ?? 0, total: thread.length })}
            </h2>
            <div className="min-h-0 flex-1 overflow-auto">
              <CommentList comments={thread} active={active} onActive={setActive} />
            </div>
            {m.can.comment ? (
              <CommentComposer
                projectId={projectId}
                mockupKey={m.key}
                pin={draft}
                picking={picking}
                onPicking={setPicking}
                onClearPin={() => setDraft(null)}
              />
            ) : (
              <p className="border-t border-line-subtle px-4 py-3 text-12 text-subtle">
                {m.revisedBy ? t("common.mockups.commentOnNext", { key: m.revisedBy }) : t("common.mockups.commentsClosed")}
              </p>
            )}
          </aside>
        </div>
      </div>
      {filing ? <FeedbackAbout projectId={projectId} slug={slug} m={m} onClose={() => setFiling(false)} /> : null}
    </MediaOverlay>
  );
}
