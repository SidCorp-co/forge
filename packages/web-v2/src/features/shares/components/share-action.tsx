"use client";

import { useState } from "react";
import type { ShareSubject } from "../subject";
import { ShareDialog } from "./share-dialog";

/**
 * The Share control of an answer's action row, beside Copy. The dialog is mounted only while open,
 * so a link it showed is gone once it closes: it is never shown again.
 */
export function ShareAction({
  projectId,
  subject,
  manageHref,
}: {
  projectId: string;
  subject: ShareSubject;
  manageHref?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-sm underline-offset-2 hover:text-fg hover:underline"
        data-testid="message-share"
        data-subject-kind={subject.kind}
      >
        Share
      </button>
      {open && (
        <ShareDialog projectId={projectId} subject={subject} manageHref={manageHref} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
