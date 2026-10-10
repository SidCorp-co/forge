
import type { UnblockCascadeFrame } from "@forge/contracts/ws-frames";
import { useEffect } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { wsClient } from "@/lib/ws/client";
import { useToast } from "@/providers/toast-provider";

function describeCascade(d: UnblockCascadeFrame, t: Copy): string {
	const names = d.dependents.map((x) => x.displayId);
	const shown = names.join(", ");
	return d.overflow > 0 ? t("issues.cascade.more", { shown, n: d.overflow }) : shown;
}

/**
 * Mounted once in the workspace layout. Without it these two events reach a
 * no-op branch of the event router, which is where they sat while a comment
 * named a consumer file that did not exist.
 */
export function useUnblockCascadeToasts(): void {
	const { toast } = useToast();
	const t = useCopy();

	useEffect(() => {
		return wsClient.on((env) => {
			if (env.event !== "issue.unblockCascade") return;
			const d = env.data;
			if (!Array.isArray(d.dependents) || d.dependents.length === 0) return;
			const blocker = d.blockerDisplayId ?? t("issues.cascade.aBlocker");
			toast({
				title: d.dependents.length === 1 ? t("issues.cascade.releasedOne", { blocker }) : t("issues.cascade.releasedMany", { blocker, n: d.dependents.length }),
				description: describeCascade(d, t),
				tone: "info",
			});
		});
	}, [toast, t]);
}
