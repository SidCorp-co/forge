import slugs from "./help-slugs.generated.json";

/** The help pages the web carries, by slug; core's web host reads the same list from the build. */
export const HELP_SLUGS: readonly string[] = slugs;
