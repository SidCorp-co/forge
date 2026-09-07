"use client";

// The issue description, read and written. Reading is `<BodyView>`, which draws
// a component body as components and a markdown body exactly as before.
// Writing is ISS-967 gap 4: `PATCH /api/issues/:id` has always accepted
// `description`, and until now nothing in the browser sent it, so a description
// typed wrong at create stayed wrong forever.

import { useState } from "react";
import {
  BodyView,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/design";
import type { AttachmentRow, IssueDetail } from "../types";
import { AttachmentList } from "./attachment-list";
import { BodyEditor } from "./body-editor";
import { useSaveDescription } from "../hooks";

export interface DescriptionCardProps {
  issue: IssueDetail;
  attachments: AttachmentRow[];
  canWrite: boolean;
}

export function DescriptionCard({ issue, attachments, canWrite }: DescriptionCardProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = useSaveDescription(issue.id);
  const editing = draft !== null;

  // cm:guard the artifact resolves against the ISSUE's attachments here, in the feature, and never inside `<BodyView>` — the design layer holds no API client (arch `web-design-holds-no-api-client`), and a `forge-artifact` whose id is not in this list must fall through to the generic block rather than draw a broken link.
  const renderArtifact = (id: string) => {
    const row = attachments.find((a) => a.id === id);
    return row ? <AttachmentList rows={[row]} /> : null;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Description</CardTitle>
          {canWrite && !editing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft(issue.description ?? "")}
            >
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {editing ? (
          <BodyEditor
            label="Issue description"
            value={draft}
            onChange={setDraft}
            disabled={save.isPending}
            placeholder="What is the problem, and what does done look like?"
            actions={
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={save.isPending}
                  onClick={() =>
                    save.mutate(
                      { id: issue.id, body: { description: draft } },
                      { onSuccess: () => setDraft(null) },
                    )
                  }
                >
                  Save
                </Button>
              </div>
            }
          />
        ) : issue.description ? (
          <BodyView
            body={issue.description}
            format={issue.descriptionFormat}
            nodes={issue.descriptionNodes}
            renderArtifact={renderArtifact}
          />
        ) : (
          <p className="fg-body-sm text-muted">
            {canWrite ? "No description yet — Edit adds one." : "No description."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
