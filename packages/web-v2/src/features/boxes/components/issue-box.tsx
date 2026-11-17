// An issue's box (ISS-1276 c7): the box testing this issue now, if one runs or waits, as one line
// that opens it on the Boxes page; and Reproduce, which opens a box a person holds for the issue.

import type { BoxRecord } from "@forge/contracts/boxes";
import { ToneBadge } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link, useRouter } from "@/lib/navigation/router";
import { useAuth } from "@/providers/auth-provider";
import { useProjectBoxes } from "../hooks";
import { holderWords, isEnded, isLive, STATE_TONE } from "../labels";
import { BoxOpen } from "./box-open";

const boxesHref = (slug: string, boxId: string) => `/projects/${slug}/boxes?box=${encodeURIComponent(boxId)}`;

function OneBox({ box, slug }: { box: BoxRecord; slug: string }) {
  const t = useCopy();
  const me = useAuth().user?.id;
  const line = [t(`boxes.mode.${box.mode}`), holderWords(box, me, t), box.criterion ? t("boxes.row.criterion", { n: box.criterion }) : null, box.queue?.reason].filter(Boolean).join(" · ");
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2 text-13" data-testid="issue-box" data-state={box.state}>
      <ToneBadge tone={STATE_TONE[box.state]} label={t(`boxes.state.${box.state}`)} title={t(`boxes.state.${box.state}`)} value={box.state} pulse={isLive(box)} />
      <span className="min-w-0 truncate text-muted">{line}</span>
      <Link className="text-link hover:underline" href={boxesHref(slug, box.id)}>
        {t("boxes.issue.watch")}
      </Link>
    </li>
  );
}

export function IssueBox({ projectId, issueId, slug, canWrite }: { projectId: string; issueId: string; slug: string; canWrite: boolean }) {
  const t = useCopy();
  const router = useRouter();
  const boxes = (useProjectBoxes(projectId).data ?? []).filter((b) => b.issueId === issueId && !isEnded(b));
  if (boxes.length === 0 && !canWrite) return null;
  return (
    <div className="grid gap-2" data-testid="issue-box-row">
      <span className="text-12 font-semibold uppercase tracking-wide text-muted">{t("boxes.issue.label")}</span>
      {boxes.length > 0 ? (
        <ul className="grid gap-1">
          {boxes.map((b) => (
            <OneBox key={b.id} box={b} slug={slug} />
          ))}
        </ul>
      ) : null}
      {canWrite ? <BoxOpen projectId={projectId} issueId={issueId} label={t("boxes.issue.reproduce")} onOpened={(b) => router.push(boxesHref(slug, b.id))} /> : null}
    </div>
  );
}
