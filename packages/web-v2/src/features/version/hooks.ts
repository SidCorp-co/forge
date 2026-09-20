import { useQuery } from "@tanstack/react-query";
import { versionApi } from "./api";

/** The deployment's own version. Keyed `['forge', 'version']`. */
export function useForgeVersion() {
	return useQuery({
		queryKey: ["forge", "version"],
		queryFn: versionApi.get,
		staleTime: 5 * 60_000,
		retry: 1,
	});
}
