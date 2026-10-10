"use client";

// Write a channel document (`/projects/[slug]/ecosystem/channel/new`): a new one, a reply
// (`?inReplyTo=`), or an edit of a draft (`?draft=`); built by `ecosystemRoutes.compose`.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ComposeScreen } from "@/features/ecosystem/components/compose-screen";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";
import { ecosystemRoutes } from "@/features/ecosystem/routes";
import { useCopy } from "@/lib/i18n/interface-language";

function Compose() {
  const t = useCopy();
  const search = useSearchParams();
  const router = useRouter();
  const read = (k: string) => search?.get(k) || undefined;
  const opts = { ecosystem: read("ecosystem"), inReplyTo: read("inReplyTo"), draft: read("draft") };
  const title = opts.draft
    ? t("ecosystem.doc.editDraft")
    : opts.inReplyTo
      ? t("ecosystem.page.replyTo", { ref: opts.inReplyTo })
      : t("ecosystem.page.newDocument");
  return (
    <EcosystemPage section="channel" title={title}>
      {(project) => (
        <ComposeScreen
          projectId={project.id}
          slug={project.slug}
          role={project.role}
          params={opts}
          onSaved={(view) => router.push(ecosystemRoutes.document(project.slug, view.document.number ?? view.id))}
        />
      )}
    </EcosystemPage>
  );
}

export default function ChannelComposePage() {
  return (
    <Suspense fallback={null}>
      <Compose />
    </Suspense>
  );
}
