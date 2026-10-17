"use client";

import { useState } from "react";
import { Button, ConfirmDialog, Tooltip } from "@/design";
import { useSweepZombies } from "../hooks";

const LABEL = "End silent sessions";

export const END_SILENT_MESSAGE =
  "Every step or agent chat on this project that stopped checking in, or waited in the queue past its limit, ends now as failed, as core would end it on its next pass. Run sessions and masters keep their own clock.";

/** Ends now what core's loop monitor would end on its next pass, asked first as Stop session is. */
export function EndSilentSessions({ projectId }: { projectId: string | null }) {
  const sweep = useSweepZombies();
  const [asked, setAsked] = useState(false);

  if (!projectId) {
    return (
      <Tooltip label="Available on a project's sessions page (owner/admin).">
        <Button variant="secondary" size="sm" icon="trash" disabled>
          {LABEL}
        </Button>
      </Tooltip>
    );
  }

  return (
    <>
      <Button variant="secondary" size="sm" icon="trash" onClick={() => setAsked(true)}>
        {LABEL}
      </Button>
      <ConfirmDialog
        open={asked}
        title="End silent sessions?"
        message={END_SILENT_MESSAGE}
        confirmLabel={LABEL}
        cancelLabel="Keep them"
        tone="danger"
        loading={sweep.isPending}
        onConfirm={() => sweep.mutate(projectId, { onSuccess: () => setAsked(false) })}
        onClose={() => setAsked(false)}
      />
    </>
  );
}
