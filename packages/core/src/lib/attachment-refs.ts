/**
 * The already-attached document an `ATTACHMENT_NAME_TAKEN` refusal points at.
 *
 * Lives in `lib/` rather than in either attachment service because both the
 * issue and the comment services refuse with it and neither domain may import
 * the other. `id` is what the delete verb takes; `url` is where the bytes are.
 */
export interface ExistingAttachmentRef {
  id: string;
  name: string;
  url: string;
}
