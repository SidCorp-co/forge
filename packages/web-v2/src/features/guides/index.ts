// The face of the guides feature: what other features import of it (CODE-STANDARD.md, Structure).
export { fetchGuide, fetchGuideCorpus } from "./api";
export { DOORS } from "./audience";
export { GuideShell } from "./components/guide-shell";
export { PublicLanding, PublicReader, PublicRefusal } from "./components/public-docs";
export { buildCorpus, fromGuide, helpPageHref, searchPlaceholder } from "./corpus";
export { INDEX_HREF, MISSING_GUIDE_BODY, MISSING_GUIDE_LINK_TEXT, missingGuideHeading } from "./missing";
export { readPublicRequest, toSearchParams } from "./requested-page";
export { GUIDE_PATH_HEADER, slugFromGuidePath } from "./requested-path";
