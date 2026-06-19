"use client";

// Realtime notification delivery bridge (ISS-510).
//
// Subscribes to the WS `notification.created` stream and, per the
// `@forge/contracts` channel matrix, fans each incoming event out to the
// transient surfaces the bell does NOT cover:
//   • `toast`   — a clickable on-screen toast (tone from severity).
//   • `browser` — a native OS notification (when permitted + opted-in + the tab
//                 is unfocused; see lib/notifications/browser).
//
// The persistent bell is driven separately by the event-router's query
// invalidation, so this hook never touches React Query. Mounted ONCE in the
// workspace layout, where the issue-routing handler already lives.
import { useEffect } from "react";
import { type NotificationSeverity, channelsFor, defaultSeverityForType } from "@forge/contracts/notifications";
import type { ToastTone } from "@/design/primitives/toast";
import { fireBrowserNotification } from "@/lib/notifications/browser";
import { playNotificationSound } from "@/lib/notifications/sound";
import { wsClient } from "@/lib/ws/client";
import { useToast } from "@/providers/toast-provider";

/** Map contract severity → toast tone. `warning` has no dedicated tone yet, so
 *  it borrows the neutral `default` card (its bell hue is still amber). */
export function severityToTone(severity: NotificationSeverity): ToastTone {
  switch (severity) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "warning":
      return "default";
    default:
      return "info";
  }
}

/** Pure routing decision for an incoming notification: which transient surfaces
 *  fire and with what toast tone. Bell is handled separately (query
 *  invalidation), so it is not part of this decision. Exported for tests. */
export function planNotificationDelivery(input: {
  type: string;
  severity?: NotificationSeverity | null;
}): { toast: boolean; browser: boolean; tone: ToastTone } {
  const channels = channelsFor(input.type);
  const severity = input.severity ?? defaultSeverityForType(input.type);
  return {
    toast: channels.includes("toast"),
    browser: channels.includes("browser"),
    tone: severityToTone(severity),
  };
}

/** Whether the audible cue should play for a given delivery plan: the sound
 *  piggybacks on the toast/browser decision, so it fires for high-signal types
 *  and stays silent for bell-only/unknown ones. The opt-in gate lives inside
 *  `playNotificationSound`. Exported for tests. */
export function shouldPlaySound(plan: { toast: boolean; browser: boolean }): boolean {
  return plan.toast || plan.browser;
}

/** The subset of the WS `notification.created` payload this bridge consumes. */
export interface DeliveryNotification {
  notificationId: string;
  type: string;
  title: string;
  body?: string | null;
  severity?: NotificationSeverity | null;
  issueId: string | null;
  projectId: string | null;
}

/**
 * @param onNavigate invoked when the user clicks a toast or browser
 *   notification — should mark-read + deep-link to the related target.
 */
export function useNotificationDelivery(
  onNavigate: (n: DeliveryNotification) => void,
): void {
  const { toast } = useToast();

  useEffect(() => {
    const off = wsClient.on((env) => {
      if (env.event !== "notification.created") return;
      const d = env.data as DeliveryNotification;
      if (!d || typeof d.type !== "string") return;

      const plan = planNotificationDelivery(d);

      if (shouldPlaySound(plan)) playNotificationSound();

      if (plan.toast) {
        toast({
          title: d.title,
          description: d.body ?? undefined,
          tone: plan.tone,
          onClick: () => onNavigate(d),
        });
      }
      if (plan.browser) {
        fireBrowserNotification({
          title: d.title,
          body: d.body ?? undefined,
          tag: d.notificationId,
          onClick: () => onNavigate(d),
        });
      }
    });
    return off;
  }, [toast, onNavigate]);
}
