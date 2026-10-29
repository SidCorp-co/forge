import { Badge } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { LiveReach } from "../types";

/**
 * Whether a merged issue's work is on production, as Forge's release records say it. Where no
 * record says either way, that is shown with what is missing and who owes it, never as live.
 */
export function LiveReachValue({ reach }: { reach: LiveReach }) {
  const t = useCopy();
  if (reach.state === "on_live") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Badge tone="green">{t("issues.reach.onLive")}</Badge>
        <span className="fg-caption">{t("issues.reach.shippedIn", { version: reach.release.version })}</span>
      </div>
    );
  }
  const notOnLive = reach.state === "not_on_live";
  return (
    <div className="flex flex-col items-end gap-1">
      <Badge tone={notOnLive ? "red" : "amber"}>
        {notOnLive ? t("issues.reach.notOnLive") : t("issues.reach.unrecorded")}
      </Badge>
      <span className="fg-caption">{notOnLive ? reach.why : reach.missing}</span>
      <span className="fg-caption">{t("issues.reach.owes", { owes: reach.owes })}</span>
    </div>
  );
}
