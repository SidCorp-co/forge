"use client";

import Link from "next/link";
import { Card, CardContent, SectionTitle } from "@/design";
import { AssistantWeeklySection } from "./assistant-weekly-section";
import { PluginsSection } from "./plugins-section";
import { PolicySection } from "./policy-section";
import { ReleaseSection } from "./release-section";

export function PipelineTab({
  projectId,
  canEdit,
  slug,
}: {
  projectId: string;
  canEdit: boolean;
  slug?: string;
}) {
  const libraryHref = slug ? `/projects/${slug}/library?tab=skills` : undefined;

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-1">Pipeline</SectionTitle>
        <p className="fg-body-sm mb-1 text-muted">
          An issue is picked up at <b>Queued</b>, runs as one session, and ends either at{" "}
          <b>Needs a human</b>, <b>Awaiting release</b> or closed. The session is driven by the{" "}
          <code>issue-flow</code> skill, which this project gets from a plugin — see Plugins below.
        </p>
        {libraryHref && (
          <p className="fg-caption mb-4">
            <Link href={libraryHref} className="text-accent-text hover:underline">
              Manage or create skills in Library →
            </Link>
          </p>
        )}

        <PolicySection projectId={projectId} canEdit={canEdit} />

        <ReleaseSection projectId={projectId} slug={slug} />

        <PluginsSection projectId={projectId} canEdit={canEdit} />

        <AssistantWeeklySection projectId={projectId} canEdit={canEdit} />
      </CardContent>
    </Card>
  );
}
