import { Button, HelpButton, IconButton, Menu, type MenuItem } from "@/design";
import { AskAboutThis } from "@/features/chat-dock/ask-about-this";
import { useCopy } from "@/lib/i18n/interface-language";
import { useCopyShareLink } from "@/lib/navigation/use-copy-share-link";
import { useRouter } from "next/navigation";
import type { IssueDetail, IssueStatus } from "../../types";
import { type StartReading, StartIssueAction } from "../start-issue-action";
import { issueSessionsHref } from "@/lib/routes/agents";

/** The header's one primary act, asking and help, and the actions menu. */
export function IssueActions({
  issue,
  slug,
  linkId,
  canWrite,
  pending,
  start,
  isRunActive,
  exitsHere,
  onTransition,
  onStarted,
}: {
  issue: IssueDetail;
  slug: string;
  /** The id the page was opened by, as the shared link repeats it. */
  linkId: string;
  canWrite: boolean;
  pending: boolean;
  start: StartReading;
  isRunActive: boolean;
  /** The statuses the issue machine draws from this one; Pause and Reopen are offered only where it does. */
  exitsHere: IssueStatus[];
  onTransition: (toStatus: IssueStatus) => void;
  onStarted: () => void;
}) {
  const router = useRouter();
  const copyShareLink = useCopyShareLink();
  const t = useCopy();
  const isTerminal = issue.status === "awaiting_release" || issue.status === "closed";
  const openSessions = () => router.push(issueSessionsHref(slug, issue.id));
  const openPipeline = () => router.push(`/projects/${slug}/pipeline`);

  function copyLink() {
    copyShareLink(`/projects/${slug}/issues/${linkId}`);
  }

  const moreItems: MenuItem[] = [
    { label: t("issues.actions.openSession"), icon: "agent", onSelect: openSessions },
    { label: t("issues.actions.openPipeline"), icon: "pipeline", onSelect: openPipeline },
    ...(!exitsHere.includes("on_hold") || !canWrite
      ? []
      : [
          {
            label: t("issues.actions.pauseHold"),
            icon: "stop",
            onSelect: () => onTransition("on_hold"),
          } as MenuItem,
        ]),
    ...(!exitsHere.includes("reopen") || !canWrite
      ? []
      : [
          {
            label: t("issues.reason.reopen.confirm"),
            icon: "rerun",
            onSelect: () => onTransition("reopen"),
          } as MenuItem,
        ]),
    { label: t("issues.actions.copyLink"), icon: "link", onSelect: copyLink },
  ];

  const primary =
    start.kind !== "none" && !isRunActive ? (
      <StartIssueAction issueId={issue.id} reading={start} onStarted={onStarted} />
    ) : !canWrite || isTerminal ? (
      canWrite ? (
        <Button variant="primary" size="sm" icon="rerun" loading={pending} onClick={() => onTransition("reopen")}>
          {t("issues.reason.reopen.confirm")}
        </Button>
      ) : (
        <Button variant="primary" size="sm" icon="pipeline" onClick={openPipeline}>
          {t("issues.actions.viewPipeline")}
        </Button>
      )
    ) : isRunActive ? (
      <Button variant="secondary" size="sm" icon="stop" loading={pending} onClick={() => onTransition("on_hold")}>
        {t("issues.actions.pause")}
      </Button>
    ) : (
      <Button variant="primary" size="sm" icon="pipeline" onClick={openPipeline}>
        {t("issues.actions.runPipeline")}
      </Button>
    );

  return (
    <span className="flex items-center gap-1.5" data-testid="issue-actions">
      {primary}
      {/* below 768px the bar holds the back control, the one primary act and the menu; asking and help wait for the room */}
      <span className="contents max-md:hidden">
        <AskAboutThis about={null} />
        <HelpButton
        summary={t("issues.help.summary")}
        actions={[t("issues.help.action1"), t("issues.help.action2"), t("issues.help.action3")]}
        shortcuts={[{ keys: "⌘K", desc: t("issues.help.palette") }]}
        />
      </span>
      <Menu align="right" items={moreItems} trigger={<IconButton icon="more" aria-label={t("issues.actions.menu")} />} />
    </span>
  );
}
