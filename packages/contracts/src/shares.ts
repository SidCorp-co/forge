// The Share port: a frozen report document turned into something a reader opens. One target,
// `forge-link`, exists; the port is there so a later one (a mail digest, a file) is an adapter
// beside it. A target that hands the document to a third-party host is refused by the owner's
// ruling, and its descriptor cannot say otherwise: `hostedBy` is the literal "forge".

import { z } from "zod";
import { ReportDocumentSchema } from "./report-templates.js";

export const SHARE_AUDIENCES = ["members", "link"] as const;
export type ShareAudience = (typeof SHARE_AUDIENCES)[number];
/** A message's blocks, a template's output, or a stored status report; never a live query or a conversation. */
export const SHARE_SUBJECT_KINDS = ["message", "template-output", "status-report"] as const;
export type ShareSubjectKind = (typeof SHARE_SUBJECT_KINDS)[number];

export const SHARE_DEFAULT_EXPIRY_DAYS = 7;
export const SHARE_MAX_EXPIRY_DAYS = 30;

export const ShareTargetDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
    hostedBy: z.literal("forge", {
      error: "a share target is hosted by Forge; handing a report to a third-party host is not allowed",
    }),
    audiences: z.array(z.enum(SHARE_AUDIENCES)).min(1),
  })
  .strict();
export type ShareTargetDescriptor = z.infer<typeof ShareTargetDescriptorSchema>;

export const ShareCreateSchema = z
  .object({
    subjectKind: z.enum(SHARE_SUBJECT_KINDS),
    subjectId: z.string().min(1),
    audience: z.enum(SHARE_AUDIENCES),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(SHARE_MAX_EXPIRY_DAYS, {
        error: `a share expires within ${SHARE_MAX_EXPIRY_DAYS} days at most`,
      })
      .default(SHARE_DEFAULT_EXPIRY_DAYS),
  })
  .strict();
export type ShareCreate = z.infer<typeof ShareCreateSchema>;

/** A share as a list shows it. The token and its hash never appear: the token is shown once, at creation. */
export const ShareLinkViewSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    audience: z.enum(SHARE_AUDIENCES),
    subjectKind: z.enum(SHARE_SUBJECT_KINDS),
    createdBy: z.string().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    revokedBy: z.string().nullable(),
    viewCount: z.number().int().min(0),
    lastViewedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type ShareLinkView = z.infer<typeof ShareLinkViewSchema>;

/** What a reader opens: the frozen document, read-only. For a `link` audience a ref cell is drawn as text. */
export const ShareSnapshotSchema = z
  .object({
    audience: z.enum(SHARE_AUDIENCES),
    expiresAt: z.iso.datetime(),
    document: ReportDocumentSchema,
  })
  .strict();
export type ShareSnapshot = z.infer<typeof ShareSnapshotSchema>;

/** The port. `publish` takes the frozen document and returns where a reader opens it. */
export interface ShareTarget extends ShareTargetDescriptor {
  publish(input: {
    projectId: string;
    audience: ShareAudience;
    expiresAt: Date;
    document: z.infer<typeof ReportDocumentSchema>;
    createdBy: string;
  }): Promise<{ id: string; url: string }>;
}
