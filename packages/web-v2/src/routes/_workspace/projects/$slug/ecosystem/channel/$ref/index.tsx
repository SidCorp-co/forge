import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { DocumentScreen } from "@/features/ecosystem/components/document-screen";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";
import { useCopy } from "@/lib/i18n/interface-language";

function ChannelDocumentPage() {
  const t = useCopy();
  const params = useParams<{ ref: string }>();
  const ref = params?.ref ? decodeURIComponent(params.ref) : "";
  return (
    <EcosystemPage section="channel" title={ref || t("ecosystem.page.document")}>
      {(project) => <DocumentScreen projectId={project.id} slug={project.slug} role={project.role} docRef={ref} />}
    </EcosystemPage>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/ecosystem/channel/$ref/")({ component: ChannelDocumentPage });
