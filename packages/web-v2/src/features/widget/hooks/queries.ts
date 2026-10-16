import type { WidgetFiled, WidgetHistory, WidgetPageContext } from "@forge/contracts/widget";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WidgetRefusal, WidgetUnreachable, widgetApi } from "../api";
import { mergeHistory, withDraft, withFiled, withMessage } from "../history";

export const widgetKeys = {
  all: ["widget"] as const,
  config: (siteKey: string) => [...widgetKeys.all, "config", siteKey] as const,
  history: (token: string) => [...widgetKeys.all, "history", token] as const,
  status: (token: string) => [...widgetKeys.all, "status", token] as const,
};

/** A refusal is the answer, read once; only an unreachable core is worth asking again. */
const retryUnreachable = (failures: number, err: unknown) => err instanceof WidgetUnreachable && failures < 2;

export const configQuery = (siteKey: string) =>
  queryOptions({
    queryKey: widgetKeys.config(siteKey),
    queryFn: () => widgetApi.config(siteKey),
    retry: retryUnreachable,
    staleTime: 5 * 60_000,
  });

/** The history read folds over what the stream put in the cache meanwhile (`mergeHistory`). */
export const historyQuery = (token: string, qc: QueryClient) =>
  queryOptions({
    queryKey: widgetKeys.history(token),
    queryFn: async () => mergeHistory(qc.getQueryData<WidgetHistory>(widgetKeys.history(token)), await widgetApi.history(token)),
    retry: retryUnreachable,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const statusQuery = (token: string) =>
  queryOptions({
    queryKey: widgetKeys.status(token),
    queryFn: () => widgetApi.status(token),
    retry: retryUnreachable,
  });

export const useWidgetConfig = (siteKey: string, enabled = true) => useQuery({ ...configQuery(siteKey), enabled });
export function useWidgetHistory(token: string) {
  const qc = useQueryClient();
  return useQuery(historyQuery(token, qc));
}
export const useWidgetStatus = (token: string, enabled = true) => useQuery({ ...statusQuery(token), enabled });

export function useSendMessage(token: string, context: WidgetPageContext | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => widgetApi.sendMessage(token, text, context ?? undefined),
    onSuccess: (message) => {
      qc.setQueryData<WidgetHistory>(widgetKeys.history(token), (h) => withMessage(h, message));
    },
  });
}

/** Files a pending draft: the draft reads filed, its status link on it as a reload reads it too. */
export function useConfirmDraft(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) => widgetApi.confirm(token, draftId),
    onSuccess: (filed, draftId) => keepFiled(qc, token, draftId, filed),
    onError: (err) => {
      if (err instanceof WidgetRefusal && err.code === "WIDGET_DRAFT_NOT_PENDING")
        void qc.invalidateQueries({ queryKey: widgetKeys.history(token) });
    },
  });
}

export function useDiscardDraft(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) => widgetApi.discard(token, draftId),
    onSuccess: (draft) => qc.setQueryData<WidgetHistory>(widgetKeys.history(token), (h) => withDraft(h, draft)),
    onError: (err) => {
      if (err instanceof WidgetRefusal && err.code === "WIDGET_DRAFT_NOT_PENDING")
        void qc.invalidateQueries({ queryKey: widgetKeys.history(token) });
    },
  });
}

export function keepFiled(qc: QueryClient, token: string, draftId: string, filed: WidgetFiled): void {
  qc.setQueryData<WidgetHistory>(widgetKeys.history(token), (h) => withFiled(h, draftId, filed));
}
