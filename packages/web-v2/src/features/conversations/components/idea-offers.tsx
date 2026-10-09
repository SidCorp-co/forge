"use client";

// The idea the assistant offers to build as a live preview (`offer_preview`, REQ-41 BC-14): a button
// in the thread. Pressing it opens the preview as the person, through the project's preview route;
// core checks their access again and places the sketch run. Nothing opens before the press.

import { IDEA_OFFER_TOOL, type IdeaOffer, readIdeaOffer } from "@forge/contracts/idea-offer";
import type { PreviewRecord } from "@forge/contracts/preview";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/design";
import type { CanonicalBlock } from "@/features/session/types";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import { ideaApi } from "@/features/previews/idea-api";
import { IdeaPanel } from "@/features/previews/idea-panel";
import { toolOutputText } from "@/lib/tool-output";

/** Every idea offer an entry's blocks carry, in the order the turn made them. */
export function ideaOffersOf(blocks: readonly CanonicalBlock[] | null | undefined): IdeaOffer[] {
  const out: IdeaOffer[] = [];
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || b.toolCall?.name !== IDEA_OFFER_TOOL || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    const offer = readIdeaOffer(toolOutputText(b.toolCall.output));
    if (offer) out.push(offer);
  }
  return out;
}

export function IdeaOfferCard({ offer }: { offer: IdeaOffer }) {
  const t = useCopy();
  const project = useProjects().data?.find((p) => p.id === offer.projectId);
  const open = useMutation<PreviewRecord>({ mutationFn: () => ideaApi.open(offer.projectId, { about: offer.about, brief: offer.brief }) });
  return (
    <div data-testid="idea-offer" data-about={offer.about} className="flex flex-col gap-1.5 border-l-2 border-line py-1 pl-3">
      <p className="fg-body-sm font-semibold text-fg">
        {t("previews.idea.offer.title", { key: offer.about })}
        <span className="font-normal text-muted"> · {offer.title}</span>
      </p>
      <p className="fg-caption text-subtle">“{offer.brief}”</p>
      {open.data ? (
        <IdeaPanel preview={open.data} about={offer.about} canWrite={canWriteProject(project?.role)} slug={project?.slug} />
      ) : (
        <>
          <p className="fg-caption text-muted">{t("previews.idea.offer.what")}</p>
          <div>
            <Button size="sm" variant="primary" loading={open.isPending} onClick={() => open.mutate()}>
              {t("previews.idea.offer.build")}
            </Button>
          </div>
        </>
      )}
      {open.isError ? (
        <p className="fg-caption text-danger" role="alert">
          {formatApiError(open.error)}
        </p>
      ) : null}
    </div>
  );
}
