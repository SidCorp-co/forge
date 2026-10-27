import type { RecordedReleaseVerification, ReleaseVerified } from "@forge/contracts/releases";
import type { Copy } from "@/lib/i18n/product-copy";

// What a release verified, in words (JU-11): the level core read off its criteria and its deploy
// check, so "No criteria" beside a deploy probe is never read as proof of the change.

/** "Verified: 3 criteria proven, and the deploy checked by the production probes". */
export function verifiedSentence(v: ReleaseVerified, t: Copy): string {
  const level = t(`releases.verified.${v.level}`, { proven: v.proven, total: v.total });
  // the criteria were counted on the build the project's testing environment serves (REQ-36 BC-18)
  const head = v.judgedOn && v.total > 0 ? t("releases.verified.onEnvironment", { head: level, environment: v.judgedOn }) : level;
  if (v.check === "landed") return `${head}, ${t("releases.verified.landed")}`;
  if (v.level === "deploy_only" || v.level === "none" || v.check === null || v.check === "unverified") return head;
  return `${head}, ${t("releases.verified.andDeploy", { how: deployCheck(v.check, v.provider, t) })}`;
}

function deployCheck(check: Exclude<RecordedReleaseVerification, "unverified" | "landed">, provider: string | null, t: Copy): string {
  if (check !== "provider") return t(`releases.verifiedBy.${check}`).toLowerCase();
  return provider ? t("releases.verified.byNamedProvider", { provider }) : t("releases.verified.byProvider");
}
