import { Button, HelpButton, IconButton, Menu, type MenuItem } from "@/design";
import { AskAboutThis } from "@/features/conversations/components/ask-about-this";
import { buildShareLink } from "@/features/shell";
import { useToast } from "@/providers/toast-provider";
import { useRouter } from "next/navigation";
import type { IssueDetail, IssueStatus } from "../../types";
import { type StartReading, StartIssueAction } from "../start-issue-action";

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
  const { toast } = useToast();
  const isTerminal = issue.status === "awaiting_release" || issue.status === "closed";
  const openSessions = () => router.push(`/projects/${slug}/agents?issue=${issue.id}`);
  const openPipeline = () => router.push(`/projects/${slug}/pipeline`);

  function copyLink() {
    const url = buildShareLink(`/projects/${slug}/issues/${linkId}`);
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      () => toast({ title: "Couldn't copy link", tone: "error" }),
    );
  }

  const moreItems: MenuItem[] = [
    { label: "Open session", icon: "agent", onSelect: openSessions },
    { label: "Open pipeline", icon: "pipeline", onSelect: openPipeline },
    ...(!exitsHere.includes("on_hold") || !canWrite
      ? []
      : [
          {
            label: "Pause (hold)",
            icon: "stop",
            onSelect: () => onTransition("on_hold"),
          } as MenuItem,
        ]),
    ...(!exitsHere.includes("reopen") || !canWrite
      ? []
      : [
          {
            label: "Reopen",
            icon: "rerun",
            onSelect: () => onTransition("reopen"),
          } as MenuItem,
        ]),
    { label: "Copy link", icon: "link", onSelect: copyLink },
  ];

  const primary =
    start.kind !== "none" && !isRunActive ? (
      <StartIssueAction issueId={issue.id} reading={start} onStarted={onStarted} />
    ) : !canWrite || isTerminal ? (
      canWrite ? (
        <Button variant="primary" size="sm" icon="rerun" loading={pending} onClick={() => onTransition("reopen")}>
          Reopen
        </Button>
      ) : (
        <Button variant="primary" size="sm" icon="pipeline" onClick={openPipeline}>
          View pipeline
        </Button>
      )
    ) : isRunActive ? (
      <Button variant="secondary" size="sm" icon="stop" loading={pending} onClick={() => onTransition("on_hold")}>
        Pause
      </Button>
    ) : (
      <Button variant="primary" size="sm" icon="pipeline" onClick={openPipeline}>
        Run pipeline
      </Button>
    );

  return (
    <span className="flex items-center gap-1.5" data-testid="issue-actions">
      {primary}
      {/* below 768px the bar holds the back control, the one primary act and the menu; asking and help wait for the room */}
      <span className="contents max-md:hidden">
        <AskAboutThis kind="issue" refId={issue.displayId} />
        <HelpButton
        summary="The full record for one issue: whose turn it is, then Overview, Criteria, Runs and Activity as tabs beside its facts."
        actions={[
          "Edit properties (status, priority, complexity) in the rail",
          "Start an open issue on a project that starts work by hand, or pause / reopen it, from the header",
          "Jump to related sessions, pipeline, and runs from the actions menu",
        ]}
        shortcuts={[{ keys: "⌘K", desc: "Open the command palette" }]}
        />
      </span>
      <Menu align="right" items={moreItems} trigger={<IconButton icon="more" aria-label="Issue actions" />} />
    </span>
  );
}
