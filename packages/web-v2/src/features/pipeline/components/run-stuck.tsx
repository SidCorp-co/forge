import { WaitingOn } from "@/design";
import { useStuckReasons } from "@/features/standing";
import { useCopy } from "@/lib/i18n/interface-language";

/** Why the run's issue is stuck and who acts on it next, from the one standing read (REQ-74 BC-5); nothing where it is not stuck. */
export function RunStuck({ projectId, issueKey }: { projectId: string | undefined; issueKey: string | null }) {
  const t = useCopy();
  const stuck = useStuckReasons(projectId, "issue").get(issueKey ?? "");
  if (!issueKey || !stuck) return null;
  return (
    <div className="flex flex-col gap-1 border-y border-line-subtle py-2" data-testid="run-stuck">
      <span className="text-12 font-semibold text-muted">{t("issues.attention.stuck")}</span>
      <span className="text-13 text-fg">{stuck.reason}</span>
      <WaitingOn w={stuck.waitingOn} />
    </div>
  );
}
