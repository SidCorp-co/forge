import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen";
import "./styles/globals.css";

// A query string is read as plain strings, the way the screens read URLSearchParams.
const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL,
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (search) => {
    const query = new URLSearchParams(search as Record<string, string>).toString();
    return query ? `?${query}` : "";
  },
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("app");
if (!root) throw new Error("index.html carries no #app element to render the web into");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
