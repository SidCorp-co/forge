
import { NotFoundBody } from "@/features/shell/components/not-found-body";

/**
 * Global 404. Renders OUTSIDE the _workspace shell, so it is fully
 * self-contained (own centering + app background), in English as every screen is (ISS-1071).
 */
export function RootNotFound() {
  return <NotFoundBody />;
}
