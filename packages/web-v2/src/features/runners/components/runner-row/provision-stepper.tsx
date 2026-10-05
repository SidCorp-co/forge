import { Banner, HealthDot, Icon } from "@/design";
import { PROVISION_LABEL, PROVISION_STEPS, type ProjectRunner } from "../../types";

/** Horizontal step row reflecting one runner's provision lifecycle. */
export function ProvisionStepper({ runner }: { runner: ProjectRunner }) {
	const status = runner.provisionStatus;
	if (!status) {
		return <span className="fg-body-sm text-subtle">Not provisioned</span>;
	}
	if (status === "needs_manual_setup" || status === "failed") {
		return (
			<Banner tone={status === "failed" ? "attention" : "info"}>
				<span className="font-semibold">{PROVISION_LABEL[status]}.</span>{" "}
				{runner.provisionDetail ?? "See the device logs for details."}
			</Banner>
		);
	}
	const activeIdx = PROVISION_STEPS.indexOf(status);
	return (
		<div className="flex flex-col gap-1.5">
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
			{PROVISION_STEPS.map((step, i) => {
				const done = i < activeIdx || status === "ready";
				const active = i === activeIdx && status !== "ready";
				return (
					<span key={step} className="inline-flex items-center gap-1.5">
						<HealthDot
							health={done ? "healthy" : "idle"}
							withLabel={false}
						/>
						<span
							className={
								done
									? "fg-caption text-fg"
									: active
										? "fg-caption font-semibold text-accent"
										: "fg-caption text-subtle"
							}
						>
							{PROVISION_LABEL[step]}
						</span>
						{i < PROVISION_STEPS.length - 1 && (
							<Icon name="arrowRight" size={11} className="text-subtle" />
						)}
					</span>
				);
			})}
		</div>
		{/* A workspace can be ready AND incomplete — the runner reports why on
		    the same status (e.g. no PAT on the box, so the checkout's .mcp.json
		    has no `forge` server). Dropping it here is how that reason went back
		    to living only in the device's log. */}
		{status === "ready" && runner.provisionDetail && (
			<Banner tone="info">{runner.provisionDetail}</Banner>
		)}
		</div>
	);
}
