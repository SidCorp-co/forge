// What the fast lane reads from the previews module (REQ-39, docs/proposals/live-preview.md): an
// issue's approved preview, with the patch id and the files its approver saw. The previews module
// owns that row and lands in its own lane; the composition root hands its reader in at boot, so the
// fast lane names no table it does not own.

/** The latest approved preview of an issue, as its approver saw it. */
export interface ApprovedPreview {
  previewId: string;
  /** `git patch-id --stable` of the worktree's change against its base when it was approved. */
  patchId: string;
  files: readonly string[];
  approvedBy: string | null;
  approvedAt: string;
}

interface FastLanePorts {
  approvedPreviewOf: (issueId: string) => Promise<ApprovedPreview | null>;
}

let given: FastLanePorts | null = null;

export function provideFastLanePorts(ports: FastLanePorts): void {
  given = ports;
}

/**
 * The issue's approved preview; `unread` where this core serves no previews, so nothing could have
 * been approved. That answer refuses the fast lane by name and is never read as "not approved yet".
 */
export async function readApprovedPreview(
  issueId: string,
): Promise<{ approved: ApprovedPreview | null } | { unread: string }> {
  if (!given) {
    return {
      unread:
        'this core serves no live previews (no previews reader was provided at boot), so no preview of it can have been approved',
    };
  }
  return { approved: await given.approvedPreviewOf(issueId) };
}
