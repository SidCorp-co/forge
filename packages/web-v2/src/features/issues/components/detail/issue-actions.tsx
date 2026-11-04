import { HelpButton, IconButton, Menu, type MenuItem } from "@/design";
import { AskAboutThis } from "@/features/chat-dock";
import { useCopy } from "@/lib/i18n/interface-language";
import { copyShareLink } from "@/lib/navigation/copy-share-link";
import { useRouter } from "@/lib/navigation/router";
import type { IssueDetail } from "../../types";
import { type StartReading, StartIssueAction } from "../start-issue-action";
import { issueSessionsHref } from "@/lib/routes/agents";

/**
 * The header's asking and help, and a menu that only opens and copies. A person never works an
 * issue (REQ-68 BC-6): running, pausing, resuming and reopening it are the agents' acts, so the
 * header offers none of them. The one start it keeps is a manual-intake project's, which its policy
 * names a person's (`start-issue-action.tsx`).
 */
export function IssueActions({
  issue,
  slug,
  linkId,
  start,
  isRunActive,
  onStarted,
}: {
  issue: IssueDetail;
  slug: string;
  /** The id the page was opened by, as the shared link repeats it. */
  linkId: string;
  start: StartReading;
  isRunActive: boolean;
  onStarted: () => void;
}) {
  const router = useRouter();
  const t = useCopy();
  const openSessions = () => router.push(issueSessionsHref(slug, issue.id));
  const openPipeline = () => router.push(`/projects/${slug}/pipeline`);

  function copyLink() {
    copyShareLink(`/projects/${slug}/issues/${linkId}`, t);
  }

  const moreItems: MenuItem[] = [
    { label: t("issues.actions.openSession"), icon: "agent", onSelect: openSessions },
    { label: t("issues.actions.openPipeline"), icon: "pipeline", onSelect: openPipeline },
    { label: t("issues.actions.copyLink"), icon: "link", onSelect: copyLink },
  ];

  return (
    <span className="flex items-center gap-1.5" data-testid="issue-actions">
      {start.kind !== "none" && !isRunActive ? <StartIssueAction issueId={issue.id} reading={start} onStarted={onStarted} /> : null}
      {/* below 768px of page column the bar holds the back control, the start where one is owed and the menu; asking and help wait for the room */}
      <span className="contents max-column-md:hidden">
        <AskAboutThis about={null} />
        <HelpButton
        actions={[t("issues.help.action1"), t("issues.help.action2"), t("issues.help.action3")]}
        shortcuts={[{ keys: "⌘K", desc: t("issues.help.palette") }]}
        />
      </span>
      <Menu align="right" items={moreItems} trigger={<IconButton icon="more" aria-label={t("issues.actions.menu")} />} />
    </span>
  );
}
