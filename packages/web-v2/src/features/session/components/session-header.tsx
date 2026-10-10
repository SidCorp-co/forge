
// The session page's sticky header: back, title and status, and its acts. The id, the task count and
// the rail toggles are the developer view's (REQ-43 BC-7), switched beside the acts.
import { useRouter } from "@/lib/navigation/router";
import type { ReactNode } from "react";
import { Badge, Button, IconButton, Menu, type MenuItem, MonoTag, PageTitle, type RecordView, RecordViewSwitch, StatusBadge } from "@/design";
import { type deriveSessionDisplayStatus, sessionStep, statusToChip, useCancelSession, useRerunSession } from "@/features/sessions";
import { useCopy } from "@/lib/i18n/interface-language";
import { copyShareLink } from "@/lib/navigation/copy-share-link";
import type { useSession } from "../hooks";

type SessionDetail = NonNullable<ReturnType<typeof useSession>["data"]>;

export function SessionHeader({
  session,
  display,
  live,
  taskCount,
  developer,
  onView,
  projectSlug,
  lastTurnId,
  onFork,
  onOpenSession,
  railCollapsed,
  onToggleRail,
  onOpenRail,
}: {
  session: SessionDetail;
  display: ReturnType<typeof deriveSessionDisplayStatus>;
  live: boolean;
  taskCount: number;
  developer: boolean;
  onView: (v: RecordView) => void;
  projectSlug: string | undefined;
  lastTurnId: string | undefined;
  onFork: (turnId: string) => void;
  onOpenSession: (id: string) => void;
  railCollapsed: boolean;
  onToggleRail: () => void;
  onOpenRail: () => void;
}) {
  const router = useRouter();
  const t = useCopy();
  const goBack = projectSlug ? () => router.push(`/projects/${projectSlug}/agents`) : undefined;
  function copyLink() {
    if (!projectSlug) return;
    copyShareLink(`/projects/${projectSlug}/agents/${session.id}`, t);
  }

  // Overflow menu — Branch/View runner machine/Copy link (ISS-351). Branching forks from the
  // newest turn, so it is offered only when the newest turn is loaded.
  const menuItems = [
    ...(lastTurnId
      ? [
          {
            label: t("sessions.detail.branch"),
            icon: "fork" as const,
            onSelect: () => onFork(lastTurnId),
          },
        ]
      : []),
    ...(session.deviceId
      ? [
          {
            label: t("sessions.detail.viewRunner"),
            icon: "server" as const,
            onSelect: () => router.push("/runners"),
          },
        ]
      : []),
    {
      label: t("sessions.detail.copyLink"),
      icon: "link" as const,
      onSelect: copyLink,
    },
  ];

  const railToggle = (
    <IconButton
      icon={railCollapsed ? "chevronLeft" : "panelLeft"}
      aria-label={railCollapsed ? t("sessions.detail.showRail") : t("sessions.detail.hideRail")}
      aria-pressed={railCollapsed}
      className="hidden min-h-11 min-w-11 lg:inline-flex"
      onClick={onToggleRail}
    />
  );

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-app/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {goBack && (
          <Button
            variant="ghost"
            size="sm"
            icon="arrowRight"
            className="min-h-11 rotate-180"
            aria-label={t("sessions.detail.backToSessions")}
            onClick={goBack}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <PageTitle className="fg-h3 truncate">{session.title ?? t("sessions.detail.session")}</PageTitle>
            {developer && <MonoTag hue="cobalt">{session.id.slice(0, 8)}</MonoTag>}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge family="run" value={statusToChip(display)} stage={sessionStep(session.metadata)} />
            {taskCount > 0 && (
              <Badge tone="neutral">
                {taskCount === 1 ? t("sessions.detail.taskOne") : t("sessions.detail.taskMany", { n: taskCount })}
              </Badge>
            )}
          </div>
        </div>
        <SessionActs
          session={session}
          live={live}
          developer={developer}
          onView={onView}
          projectSlug={projectSlug}
          menuItems={menuItems}
          onOpenSession={onOpenSession}
          onOpenRail={onOpenRail}
          railToggle={railToggle}
        />
      </div>
    </header>
  );
}

/** The person / developer switch, stop or rerun, open the issue, the overflow menu and, in the developer view, the rail toggles. */
function SessionActs({
  session,
  live,
  developer,
  onView,
  projectSlug,
  menuItems,
  onOpenSession,
  onOpenRail,
  railToggle,
}: {
  session: SessionDetail;
  live: boolean;
  developer: boolean;
  onView: (v: RecordView) => void;
  projectSlug: string | undefined;
  menuItems: MenuItem[];
  onOpenSession: (id: string) => void;
  onOpenRail: () => void;
  railToggle: ReactNode;
}) {
  const router = useRouter();
  const t = useCopy();
  const cancel = useCancelSession();
  const rerun = useRerunSession();
  const issueId = session.metadata?.issueId;
  return (
        <div className="flex items-center gap-1.5">
          <RecordViewSwitch view={developer ? "developer" : "person"} onView={onView} />
          {live ? (
            <Button
              variant="danger"
              size="sm"
              icon="stop"
              className="min-h-11"
              loading={cancel.isPending}
              onClick={() => cancel.mutate(session.id)}
            >
              {t("sessions.detail.stop")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon="rerun"
              className="min-h-11"
              loading={rerun.isPending}
              onClick={() =>
                rerun.mutate(session.id, {
                  onSuccess: (r) => projectSlug && onOpenSession(r.id),
                })
              }
            >
              {t("sessions.detail.rerun")}
            </Button>
          )}
          {issueId && projectSlug && (
            <Button
              variant="secondary"
              size="sm"
              icon="list"
              className="min-h-11"
              onClick={() =>
                router.push(`/projects/${projectSlug}/issues/${issueId}`)
              }
            >
              {t("sessions.detail.openIssue")}
            </Button>
          )}
          <Menu
            align="right"
            items={menuItems}
            trigger={
              <IconButton
                icon="more"
                aria-label={t("sessions.detail.actions")}
                className="min-h-11 min-w-11"
              />
            }
          />
          {developer && (
            <>
              <IconButton
                icon="rows"
                aria-label={t("sessions.detail.showContext")}
                className="min-h-11 min-w-11 lg:hidden"
                onClick={onOpenRail}
              />
              {railToggle}
            </>
          )}
        </div>
  );
}
