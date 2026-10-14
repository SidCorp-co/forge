import { createContext, use } from "react";

/**
 * The projects a connect form binds besides the one it renders for. A provider's own form is
 * written for one project; on the workspace Integrations page the person picks several, and the
 * form's one create binds them all in the same call (FB-128).
 */
const AlsoBindContext = createContext<readonly string[]>([]);

export const AlsoBindProvider = AlsoBindContext.Provider;

export function useAlsoBind(): readonly string[] {
  return use(AlsoBindContext);
}
