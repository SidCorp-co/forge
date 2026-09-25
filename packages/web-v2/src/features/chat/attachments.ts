/**
 * What a composer will stage, and what it says about a file it will not.
 *
 * The types come from `@forge/contracts`, which is the same list core enforces
 * at the upload door — not a copy of it, so the server never refuses what this
 * staged and the person never loses a file to a rule nobody printed.
 */

import { CONVERSATION_MIMES, SESSION_MIMES } from "@forge/contracts";

export interface AttachmentPolicy {
  /** The target this surface uploads under, named in the refusal. */
  target: "conversation" | "session";
  /** The mime types core's own allow-list for that target holds. */
  mimes: readonly string[];
  /** Advisory only — `accept` hints the native dialog and guarantees nothing. */
  extensions: readonly string[];
  maxBytes: number;
  maxFiles: number;
  /** How the refusal names what IS taken. */
  takes: string;
}

export const CONVERSATION_ATTACHMENTS: AttachmentPolicy = {
  target: "conversation",
  mimes: CONVERSATION_MIMES,
  extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp"],
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 10,
  takes: "a PNG, JPEG, GIF or WebP image",
};

export const SESSION_ATTACHMENTS: AttachmentPolicy = {
  target: "session",
  mimes: SESSION_MIMES,
  extensions: [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".html",
    ".pdf",
    ".txt",
    ".md",
  ],
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 10,
  takes: "an image, a PDF, or plain or markdown text",
};

/** The `accept` attribute for a policy's native file dialog. */
export function acceptAttribute(policy: AttachmentPolicy): string {
  return [...policy.mimes, ...policy.extensions].join(",");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One file this composer would not take, and why. */
export interface StagingRefusal {
  name: string;
  reason: string;
}

export interface StagingOutcome {
  accepted: File[];
  refused: StagingRefusal[];
}

function named(file: File): string {
  return file.name || "an unnamed file";
}

function typeOf(file: File): string {
  return file.type || "no type the browser could name";
}

/**
 * Decide what a pick or a drop stages. Pure, so the refusal sentences are
 * readable in a test without a file dialog.
 */
export function stageFiles(
  picked: readonly File[],
  policy: AttachmentPolicy,
  alreadyStaged: number,
): StagingOutcome {
  const accepted: File[] = [];
  const refused: StagingRefusal[] = [];
  let room = policy.maxFiles - alreadyStaged;
  for (const file of picked) {
    if (file.size <= 0) {
      refused.push({ name: named(file), reason: "it is empty" });
      continue;
    }
    if (file.size > policy.maxBytes) {
      refused.push({
        name: named(file),
        reason: `it is ${formatSize(file.size)} and a ${policy.target} takes files up to ${formatSize(policy.maxBytes)}`,
      });
      continue;
    }
    if (!policy.mimes.includes(file.type)) {
      refused.push({
        name: named(file),
        reason: `${typeOf(file)} is not a type a ${policy.target} takes — attach ${policy.takes}`,
      });
      continue;
    }
    if (room <= 0) {
      refused.push({
        name: named(file),
        reason: `one message carries at most ${policy.maxFiles} files`,
      });
      continue;
    }
    room -= 1;
    accepted.push(file);
  }
  return { accepted, refused };
}

/** The whole sentence a person reads, which names the file first. */
export function refusalSentence(refusal: StagingRefusal): string {
  return `Couldn't attach ${refusal.name} — ${refusal.reason}.`;
}
