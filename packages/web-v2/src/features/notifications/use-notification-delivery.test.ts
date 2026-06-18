import { describe, expect, it } from "vitest";
import { planNotificationDelivery, severityToTone } from "./use-notification-delivery";

describe("severityToTone (ISS-510)", () => {
  it("maps each severity to a toast tone", () => {
    expect(severityToTone("success")).toBe("success");
    expect(severityToTone("error")).toBe("error");
    expect(severityToTone("warning")).toBe("default");
    expect(severityToTone("info")).toBe("info");
  });
});

describe("planNotificationDelivery channel routing (ISS-510)", () => {
  it("routes toast-channel types to a toast", () => {
    // issue_status_changed → bell + toast (no browser).
    const plan = planNotificationDelivery({ type: "issue_status_changed", severity: "info" });
    expect(plan.toast).toBe(true);
    expect(plan.browser).toBe(false);
    expect(plan.tone).toBe("info");
  });

  it("routes browser-channel types to both toast and browser", () => {
    // pipeline_wedge → bell + toast + browser, error tone.
    const plan = planNotificationDelivery({ type: "pipeline_wedge", severity: "error" });
    expect(plan.toast).toBe(true);
    expect(plan.browser).toBe(true);
    expect(plan.tone).toBe("error");
  });

  it("keeps bell-only types off the transient surfaces", () => {
    // comment_added → bell only.
    const plan = planNotificationDelivery({ type: "comment_added", severity: "info" });
    expect(plan.toast).toBe(false);
    expect(plan.browser).toBe(false);
  });

  it("defaults severity from the contract when none is supplied", () => {
    // agent_completed default severity is success → success tone.
    const plan = planNotificationDelivery({ type: "agent_completed" });
    expect(plan.toast).toBe(true);
    expect(plan.tone).toBe("success");
  });

  it("treats an unknown/legacy type as bell-only with info tone", () => {
    const plan = planNotificationDelivery({ type: "totally_new_type" });
    expect(plan.toast).toBe(false);
    expect(plan.browser).toBe(false);
    expect(plan.tone).toBe("info");
  });
});
