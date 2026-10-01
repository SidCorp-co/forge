"use client";

import { Card, CardContent, SectionTitle } from "@/design";
import { AssistantWeeklySection } from "./assistant-weekly-section";
import { PluginsSection } from "./plugins-section";
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
  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-1">Pipeline</SectionTitle>
        <p className="fg-body-sm mb-1 text-muted">
          An issue is picked up at <b>Queued</b>, runs as one session, and ends either at{" "}
          <b>Needs a human</b>, <b>Awaiting release</b> or closed. The session is driven by the{" "}
          <code>issue-flow</code> skill, which this project gets from a plugin — see Plugins below.
          Which model runs each status, with which tools denied, is the policy on the Configuration
          tab.
        </p>

        <ReleaseSection projectId={projectId} slug={slug} />

        <PluginsSection projectId={projectId} canEdit={canEdit} />

        <AssistantWeeklySection projectId={projectId} canEdit={canEdit} />
      </CardContent>
    </Card>
  );
}
