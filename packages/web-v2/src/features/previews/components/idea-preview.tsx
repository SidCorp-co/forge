
// An idea preview beside the chat (REQ-41 BC-14, BC-15, BC-16): the sketch run's page in a frame,
// the box that asks it for a change, and Keep, which makes what the person sees the requirement's
// picture. Core decides every move; this draws the record and says by name what core refused. Flat,
// no card: a hairline at the left and type for the hierarchy.

import type { PreviewFailureReason, PreviewRecord } from "@forge/contracts/preview";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/navigation/router";
import { useRef, useState } from "react";
import { Button, Field, Input } from "@/design";
import { RefusedLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { ideaApi } from "../idea-api";
import { previewQueries } from "../queries";
import { askPageSnapshot, SnapshotUnavailable } from "../idea-snapshot";
import { PreviewFrame } from "./preview-frame";
import { MessageBox } from "./issue-preview";

type Copy = ReturnType<typeof useCopy>;
type CopyKey = Parameters<Copy>[0];


/** The idea preview's record, read again on a short clock while it starts, so a missed frame cannot leave it starting for good. */
export function useIdeaPreview(initial: PreviewRecord) {
  return useQuery(previewQueries.idea(initial));
}

const reasonKeys = (r: PreviewFailureReason) => ({ name: `previews.failed.reason.${r}` as CopyKey, fix: `previews.failed.fix.${r}` as CopyKey });

/** Keeps the idea: the page's own snapshot, taken in this browser, then core's keep. */
function useKeepIdea(preview: PreviewRecord, frameRef: React.RefObject<HTMLIFrameElement | null>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (alt: string) => {
      if (!frameRef.current) throw new SnapshotUnavailable("silent", "the preview frame is not on the page");
      const snapshot = await askPageSnapshot(frameRef.current, new URL(preview.url).origin);
      return ideaApi.keep(preview.id, { alt, snapshot });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["requirements"] });
      void qc.invalidateQueries({ queryKey: ["requirement"] });
      void qc.invalidateQueries({ queryKey: ["suggestions"] });
    },
  });
}

/** `canWrite` and `slug` come from the page that mounts it, which reads the project; no feature above this one is imported here. */
export function IdeaPreview({ preview: initial, about, canWrite, slug }: { preview: PreviewRecord; about: string; canWrite: boolean; slug: string | undefined }) {
  const t = useCopy();
  const preview = useIdeaPreview(initial).data;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [alt, setAlt] = useState("");
  const keep = useKeepIdea(preview, frameRef);
  const kept = keep.data;

  return (
    <div data-testid="idea-panel" data-state={preview.state} className="grid gap-2 border-l-2 border-line py-1 pl-3">
      <p className="fg-label text-fg" data-testid="idea-state">
        {t(`previews.state.${preview.state}`)}
      </p>
      {preview.state === "starting" ? (
        <p role="status" className="fg-body-sm text-muted">
          {t("previews.idea.starting")}
        </p>
      ) : null}
      {preview.state === "failed" ? (
        <p role="alert" data-testid="idea-failed" className="fg-body-sm text-danger-11">
          {preview.reason ? `${t(reasonKeys(preview.reason).name)}. ${t(reasonKeys(preview.reason).fix)}` : t("previews.failed.lead")}
          {preview.detail ? ` ${preview.detail}` : ""}
        </p>
      ) : null}
      {preview.state === "abandoned" || preview.state === "idle_closed" ? <p className="fg-body-sm text-muted">{t("previews.idea.closed")}</p> : null}
      {preview.state === "live" ? <PreviewFrame preview={preview} issueLabel={about} height={360} frameRef={frameRef} /> : null}
      {preview.state === "live" || preview.state === "starting" ? <MessageBox preview={preview} canWrite={canWrite} /> : null}

      {preview.state === "live" && canWrite && !kept ? (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t("previews.idea.keep.label")}
          onSubmit={(e) => {
            e.preventDefault();
            if (alt.trim()) keep.mutate(alt.trim());
          }}
        >
          <div className="min-w-0 flex-1">
            <Field label={t("previews.idea.keep.alt")}>
              <Input value={alt} maxLength={300} placeholder={t("previews.idea.keep.altPlaceholder")} onChange={(e) => setAlt(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={alt.trim() === ""} loading={keep.isPending}>
            {t("previews.idea.keep.button")}
          </Button>
        </form>
      ) : null}
      <RefusedLine label={t("previews.idea.keep.failed")} error={keep.error} className="fg-body-sm text-danger-11" />
      {kept ? (
        <div role="status" data-testid="idea-kept" className="grid gap-1">
          <p className="fg-body-sm text-fg">
            {kept.startedFrom ? t("previews.idea.kept.started", { key: kept.requirement, from: kept.startedFrom }) : t("previews.idea.kept.drawn", { key: kept.requirement })}{" "}
            {slug ? (
              <Link className="text-link hover:underline" href={requirementHref(slug, kept.requirement)}>
                {t("previews.idea.kept.open")}
              </Link>
            ) : null}
          </p>
          {kept.suggestionId ? <p className="fg-caption text-muted">{t("previews.idea.kept.criteria")}</p> : null}
          {kept.suggestionRefusal ? (
            <p className="fg-caption text-muted" data-testid="idea-criteria-refused">
              {t("previews.idea.kept.criteriaRefused")} {kept.suggestionRefusal.code}: {kept.suggestionRefusal.detail}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
