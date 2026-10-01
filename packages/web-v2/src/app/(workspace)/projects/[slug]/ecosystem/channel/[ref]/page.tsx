"use client";

// One channel document (`/projects/[slug]/ecosystem/channel/[ref]`), by number or draft id;
// built by `ecosystemRoutes.document`.
import { useParams } from "next/navigation";
import { DocumentScreen } from "@/features/ecosystem/components/document-screen";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";

export default function ChannelDocumentPage() {
  const params = useParams<{ slug: string; ref: string }>();
  const ref = params?.ref ? decodeURIComponent(params.ref) : "";
  return (
    <EcosystemPage slug={params?.slug} section="channel" title={ref || "Document"}>
      {(project) => <DocumentScreen projectId={project.id} slug={project.slug} role={project.role} docRef={ref} />}
    </EcosystemPage>
  );
}
