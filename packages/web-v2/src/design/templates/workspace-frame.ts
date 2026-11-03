// The workspace's page column and its scroller. The page scrolls `<main>`, not the document, so a page
// wider than a phone pushes `main` sideways while the document still reads the window's width. The
// screen witness mounts its pages in these same classes, so it measures the scroller a person uses
// (ISS-691).

/** The column beside the sidebar that holds the top bar and the page. */
export const WORKSPACE_PAGE_COLUMN = "flex min-w-0 flex-1 flex-col";

/** The page's scroller: the one element that scrolls a workspace page. */
export const WORKSPACE_MAIN = "min-h-0 flex-1 overflow-y-auto bg-app pb-[calc(56px+env(safe-area-inset-bottom))] window-md:pb-0";
