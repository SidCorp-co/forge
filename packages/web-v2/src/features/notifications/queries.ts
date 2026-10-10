import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { invitationsApi, notificationsApi } from "./api";

/** Every query key the bell reads under; `lib/ws/event-router.ts` invalidates the same keys. */
export const notificationKeys = {
  all: ["notifications"] as const,
  open: () => ["notifications", "open"] as const,
  members: (deliveryId: string | null) => ["notifications", "members", deliveryId] as const,
  openCount: ["notifications-open"] as const,
  invitations: ["invitations-pending"] as const,
};

export const notificationQueries = {
  /** The open rows the badge counts, a page at a time (ISS-289). */
  open: (enabled: boolean) =>
    infiniteQueryOptions({
      queryKey: notificationKeys.open(),
      queryFn: ({ pageParam }) => notificationsApi.openPage(pageParam),
      initialPageParam: 1,
      getNextPageParam: (last, pages) => {
        const loaded = pages.reduce((n, p) => n + p.items.length, 0);
        return last.items.length > 0 && loaded < last.totalCount ? pages.length + 1 : undefined;
      },
      enabled,
    }),
  openCount: () => queryOptions({ queryKey: notificationKeys.openCount, queryFn: () => notificationsApi.openCount() }),
  /** The records behind one delivery, read only once the reader expands it (ISS-1063). */
  members: (deliveryId: string | null) =>
    queryOptions({
      queryKey: notificationKeys.members(deliveryId),
      queryFn: () => notificationsApi.members(deliveryId as string),
      enabled: deliveryId !== null,
    }),
  invitations: (enabled: boolean) =>
    queryOptions({ queryKey: notificationKeys.invitations, queryFn: () => invitationsApi.pending(), enabled }),
};
