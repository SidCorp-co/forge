import { useMutation, useQueryClient } from "@tanstack/react-query";

interface UseOptimisticMutationOptions<TData, TVars> {
  queryKey: unknown[];
  mutationFn: (vars: TVars) => Promise<unknown>;
  updateData: (old: TData[] | undefined, vars: TVars) => TData[] | undefined;
  onError?: (err: unknown) => void;
}

export function useOptimisticMutation<TData, TVars>({
  queryKey,
  mutationFn,
  updateData,
  onError,
}: UseOptimisticMutationOptions<TData, TVars>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey });
      const prev = queryClient.getQueryData<TData[]>(queryKey);
      queryClient.setQueryData<TData[]>(queryKey, (old) => updateData(old, vars));
      return { prev };
    },
    onError: (_err: unknown, _vars: TVars, ctx: { prev?: TData[] } | undefined) => {
      if (ctx?.prev) queryClient.setQueryData(queryKey, ctx.prev);
      onError?.(_err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey, refetchType: "all" });
    },
  });
}
