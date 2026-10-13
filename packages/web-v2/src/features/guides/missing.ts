// The words for an unknown guide, page or door: core says them in its 404 document, the web on a
// navigation inside it (docs/modules/guides/public-pages.md).
import { missingGuideBody } from "@forge/contracts/guide-addresses";
import { coreFileUrl } from "@/lib/utils/core-url";

export {
  INDEX_HREF,
  MISSING_GUIDE_LINK_TEXT,
  missingDoor,
  missingGuideHeading,
  missingPage,
  PAGE_AND_DOOR,
  type Refusal,
} from "@forge/contracts/guide-addresses";

export const MISSING_GUIDE_BODY = missingGuideBody(coreFileUrl("/api/guides"));
