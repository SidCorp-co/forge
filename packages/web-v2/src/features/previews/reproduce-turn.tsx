"use client";

// What a turn read with `forge_recording` (REQ-41 BC-17, BC-19), drawn under its reply from the
// tool's own result, as the needs-you decisions are: the recording's timeline, the Reproduce entry
// for the item, and, where the assistant proposed one, its cause and fix with the recommended answer
// "Build the fix, ask the reporter to confirm". The model names no button: the one drawn posts the
// item's own issue route, carrying that diagnosis, as the person who presses it.

import {
  BUILD_THE_FIX,
  RECORDING_TOOL,
  type RecordingToolResult,
  recordingToolResultSchema,
  type TimelineEntry,
} from "@forge/contracts/reproduce";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { toolOutputText } from "@/lib/tool-output";
import { useCopy } from "@/lib/i18n/interface-language";
import { feedbackHref } from "@/lib/routes/feedback";
import { reproduceApi } from "./reproduce-api";
import { REPRODUCE_PARAM } from "./reproduce-section";
import { TimelineTable } from "./reproduce-timeline";

/** The blocks a turn holds, as far as this reads them: its tool calls and what they answered. */
interface ToolBlock {
  type: string;
  toolCall?: { name?: string; isError?: boolean; output?: unknown } | null;
}

/** The newest `forge_recording` result a turn's blocks hold, or null where it read none. */
export function recordingReadIn(blocks: readonly ToolBlock[] | null | undefined): RecordingToolResult | null {
  let found: RecordingToolResult | null = null;
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || !b.toolCall?.name?.endsWith(RECORDING_TOOL) || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    try {
      const parsed = recordingToolResultSchema.safeParse(JSON.parse(toolOutputText(b.toolCall.output)));
      if (parsed.success) found = parsed.data;
    } catch {
      // a result that is not the read's JSON draws nothing
    }
  }
  return found;
}

/** The first lines of a timeline a chat shows; the item's page shows the whole of it. */
const SHOWN = 12;

export function TurnReproduce({ blocks, slug }: { blocks: readonly ToolBlock[] | null | undefined; slug?: string | undefined }) {
  const read = recordingReadIn(blocks);
  if (!read) return null;
  return <ReproduceRead read={read} slug={slug} />;
}

function ReproduceRead({ read, slug }: { read: RecordingToolResult; slug?: string | undefined }) {
  const t = useCopy();
  const router = useRouter();
  const fb = read.feedback.key;
  const latest = read.recordings[0] ?? null;
  const open = useMutation({
    mutationFn: () => reproduceApi.open(read.projectId, fb),
    onSuccess: (p) => {
      if (slug) router.push(`${feedbackHref(slug, fb)}?${REPRODUCE_PARAM}=${encodeURIComponent(p.id)}`);
    },
  });
  const proposal = read.proposal;
  const shown: TimelineEntry[] = (proposal ? (read.recordings.find((r) => r.id === proposal.diagnosis.recording) ?? latest) : latest)?.timeline.slice(0, SHOWN) ?? [];
  return (
    <section className="mt-2 grid gap-2 border-l-2 border-line pl-3" data-testid="turn-reproduce" data-feedback={fb}>
      <p className="fg-body-sm text-fg">
        <span className="font-semibold">{fb}</span> <span className="text-muted">{read.feedback.title}</span>
      </p>
      {shown.length > 0 ? (
        <TimelineTable entries={shown} compact testId="turn-timeline" />
      ) : (
        <p className="fg-caption text-muted">{t("previews.turn.noRecording", { fb })}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" loading={open.isPending} onClick={() => open.mutate()} data-testid="turn-reproduce-open">
          {t("previews.reproduce.open", { fb })}
        </Button>
        {slug ? (
          <a className="fg-body-sm text-link hover:underline" href={feedbackHref(slug, fb)}>
            {t("previews.turn.openItem", { fb })}
          </a>
        ) : null}
      </div>
      {open.error ? (
        <p role="alert" className="fg-caption text-danger">
          {t("previews.reproduce.openFailed")}: {formatApiError(open.error)}
        </p>
      ) : null}
      {proposal ? <Diagnosis read={read} proposal={proposal} slug={slug} /> : null}
    </section>
  );
}

function Diagnosis({ read, proposal, slug }: { read: RecordingToolResult; proposal: NonNullable<RecordingToolResult["proposal"]>; slug?: string | undefined }) {
  const t = useCopy();
  const fb = read.feedback.key;
  const press = useMutation({ mutationFn: () => reproduceApi.buildTheFix(read.projectId, fb, proposal.diagnosis, proposal.answers) });
  const answered = (["criterion", "severity", "reproduced"] as const).filter((q) => proposal.answers[q]);
  const carrier = press.data?.feedback.route?.carriers[0]?.key ?? null;
  return (
    <div className="grid gap-1.5" data-testid="turn-diagnosis">
      <p className="fg-body-sm">
        <span className="fg-label">{t("previews.diagnosis.cause")}. </span>
        {proposal.diagnosis.cause}
      </p>
      <p className="fg-body-sm">
        <span className="fg-label">{t("previews.diagnosis.fix")}. </span>
        {proposal.diagnosis.fix}
      </p>
      {answered.map((q) => (
        <p key={q} className="fg-body-sm" data-testid={`turn-diagnosis-${q}`}>
          <span className="fg-label">{t(`previews.diagnosis.${q}`)}. </span>
          {proposal.answers[q]}
        </p>
      ))}
      {press.isSuccess ? (
        <p role="status" className="fg-body-sm text-fg" data-testid="turn-diagnosis-done">
          {t("previews.diagnosis.done", { fb, issue: carrier ?? "" })}
          {slug ? (
            <>
              {" "}
              <a className="text-link hover:underline" href={feedbackHref(slug, fb)}>
                {t("previews.turn.openItem", { fb })}
              </a>
            </>
          ) : null}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="fg-caption text-muted">{t("previews.diagnosis.recommended")}</span>
          <Button size="sm" variant="primary" disabled={!proposal.pressable} loading={press.isPending} onClick={() => press.mutate()} data-testid="turn-build-the-fix">
            {BUILD_THE_FIX}
          </Button>
        </div>
      )}
      {!proposal.pressable && proposal.why ? <p className="fg-caption text-muted">{proposal.why}</p> : null}
      {press.error ? (
        <p role="alert" className="fg-caption text-danger">
          {t("previews.diagnosis.failed", { fb })}: {formatApiError(press.error)}
        </p>
      ) : null}
    </div>
  );
}
