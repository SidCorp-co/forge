import { describe, expect, it } from "vitest";
import { planNotificationDelivery, severityToTone, shouldPlaySound } from "./use-notification-delivery";

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

  // cm:why the bell-only case used `comment_added`, which ISS-1063 deleted as a type with
  // no emitter anywhere. Every surviving type reaches at least `toast`, so the only thing
  // left that is bell-only is a type the contract does not know — which the unknown/legacy
  // case below already covers, and which is what `channelsFor`'s fallback is for.
  it("defaults severity from the contract when none is supplied", () => {
    // issue_status_changed's contract severity is info → info tone.
    const plan = planNotificationDelivery({ type: "issue_status_changed" });
    expect(plan.toast).toBe(true);
    expect(plan.tone).toBe("info");
  });

  it("treats an unknown/legacy type as bell-only with info tone", () => {
    const plan = planNotificationDelivery({ type: "totally_new_type" });
    expect(plan.toast).toBe(false);
    expect(plan.browser).toBe(false);
    expect(plan.tone).toBe("info");
  });
});

describe("shouldPlaySound (ISS-513)", () => {
  it("plays for toast/browser-channel high-signal types", () => {
    expect(shouldPlaySound(planNotificationDelivery({ type: "pipeline_wedge" }))).toBe(true);
    expect(shouldPlaySound(planNotificationDelivery({ type: "issue_status_changed" }))).toBe(true);
    expect(shouldPlaySound(planNotificationDelivery({ type: "issue_stranded" }))).toBe(true);
  });

  it("stays silent for bell-only and unknown types", () => {
    expect(shouldPlaySound(planNotificationDelivery({ type: "an_unknown_bell_only_type" }))).toBe(
      false,
    );
    expect(shouldPlaySound(planNotificationDelivery({ type: "totally_new_type" }))).toBe(false);
  });
});
