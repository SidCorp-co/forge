"use client";

// Project settings → Advanced. Soft archive / unarchive the project (ISS-353).
// Owner-only (the buttons are disabled for non-owners and the server returns
// 403). Archiving requires type-to-confirm of the project name; it hides the
// project from the default list and pauses auto-pipeline dispatch but destroys
// nothing — issues, comments, runs, and sessions are retained and unarchive
// restores it. Mirrors the destructive-action confirmation pattern used by the
// members-tab remove flow.
import { useState } from "react";
import { Button, Card, CardContent, Field, Input } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useArchiveProject, useUnarchiveProject } from "../hooks";

export function AdvancedTab({
  project,
  canEdit,
}: {
  project: ProjectDetail;
  canEdit: boolean;
}) {
  const archive = useArchiveProject(project.id);
  const unarchive = useUnarchiveProject(project.id);

  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  const isArchived = Boolean(project.archivedAt);
  const nameMatches = typed.trim() === project.name && project.name.length > 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Archive project</h2>
          {isArchived ? (
            <>
              <p className="fg-caption mb-4 text-muted">
                This project is <strong>archived</strong>. It is hidden from the default project
                list and no new pipeline jobs are dispatched. All issues, comments, runs, and
                sessions are retained. Unarchive to make it active again.
              </p>
              {canEdit && (
                <Button
                  variant="primary"
                  loading={unarchive.isPending}
                  onClick={() => unarchive.mutate()}
                  className="min-h-11"
                >
                  Unarchive project
                </Button>
              )}
            </>
          ) : (
            <>
              <p className="fg-caption mb-4 text-muted">
                Archiving hides this project from the default list and pauses auto-pipeline
                dispatch. Nothing is deleted — issues, comments, runs, and sessions are kept and
                you can unarchive at any time.
              </p>
              {canEdit &&
                (confirming ? (
                  <div className="space-y-4">
                    <Field
                      label="Confirm archive"
                      hint={`Type the project name "${project.name}" to confirm.`}
                    >
                      <Input
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        placeholder={project.name}
                        autoComplete="off"
                        aria-label="Type the project name to confirm archive"
                      />
                    </Field>
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        loading={archive.isPending}
                        disabled={!nameMatches}
                        onClick={() =>
                          archive.mutate(undefined, {
                            onSuccess: () => {
                              setConfirming(false);
                              setTyped("");
                            },
                          })
                        }
                        className="min-h-11"
                      >
                        Confirm archive
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setConfirming(false);
                          setTyped("");
                        }}
                        className="min-h-11"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="danger"
                    onClick={() => setConfirming(true)}
                    className="min-h-11"
                  >
                    Archive project
                  </Button>
                ))}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
