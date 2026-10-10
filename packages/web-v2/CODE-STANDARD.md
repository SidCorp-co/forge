# web-v2 code standard

One line per rule. Where a rule follows a library, the source is linked. Lint enforces most of these
rules (see `eslint.config.mjs`). The rest are checked in review. The page grammar (which template
and which block to use) is in [`src/design/README.md`](src/design/README.md).

## Structure

- A feature is `src/features/<domain>/` and holds `components/`, `api.ts`, `hooks.ts` and `types.ts`; its copy is `src/lib/i18n/copy/<domain>.json`. Split `api.ts` and `hooks.ts` into folders only once they outgrow one file.
- `src/design` holds tokens (the variables in `src/styles/tokens.css`), primitives, blocks and templates. A feature imports them only from `@/design`.
- `src/components/ui/*` is the shadcn layer (generated code). Only `src/design` imports it.
- A feature imports another feature only through that feature's `index.ts`. Never reach into its files.
  - ✗ `import { x } from "@/features/issues/components/issue-row"`
  - ✓ `import { x } from "@/features/issues"`
- `app/` routes stay thin: read params, then render one feature screen.

## Components

- Components are server components by default. Add `"use client"` only to the file that holds state, effects or handlers, and keep that file small. Source: [Next: server and client components](https://nextjs.org/docs/app/getting-started/server-and-client-components).
- A component is a pure function of its props and its queries. Never mutate during render. Source: [React: keeping components pure](https://react.dev/learn/keeping-components-pure).
- Prefer composition over prop explosion: pass `children` or slots, never ten boolean flags. Source: [React: passing JSX as children](https://react.dev/learn/passing-props-to-a-component#passing-jsx-as-children).
  - ✗ `<Panel showHeader showFooter compact bordered />`
  - ✓ `<Section title="Runs" actions={<Button/>}>…</Section>`
- Variants go through `cva`, and classes are joined with `cn()`. Never use inline `style`, except for a value computed at runtime (a width in %, a colour that is itself the data). Source: [cva: variants](https://cva.style/docs/getting-started/variants).
- Keep a component to about 150 lines and a file to 500 lines at most. Past that, split by what the parts show.
- Name a component for what it shows, never for a layout word. Use no new `*Row`, `*Section`, `*Card`, `*Panel` or `*Facts` names; reach for the shared block instead.
  - ✗ `IssueRightPanel`, `RunCard`
  - ✓ `IssueEvidence`, `RunOutcome`
- Never define a component inside another component. Source: [React: nesting component definitions](https://react.dev/learn/your-first-component#nesting-and-organizing-components).

## Base UI and shadcn

- Compose the documented parts: Root, Trigger, Portal, Positioner, Popup and Close. Source: [Base UI: Dialog](https://base-ui.com/react/components/dialog).
- Change the rendered element with the `render` prop. Never wrap a part in an extra element to do it. Source: [Base UI: composition](https://base-ui.com/react/handbook/composition).
- Choose controlled (`open` + `onOpenChange`) or uncontrolled (`defaultOpen`) per use. Never mirror `open` into local state. Source: [Base UI: Popover API](https://base-ui.com/react/components/popover).
- Style parts through `className` and their `data-*` state attributes (`data-open`, `data-disabled`). Source: [Base UI: styling](https://base-ui.com/react/handbook/styling).
- Never re-implement focus traps, Escape, outside-click or positioning. The primitive does them.
- Never wrap a primitive only to rename it. A `src/design` wrapper exists to apply tokens and the house variants.
- Add a new shadcn component with `pnpm dlx shadcn add <name>`, then style it in the generated file. Source: [shadcn: CLI](https://ui.shadcn.com/docs/cli).

## TanStack Query

- Give each feature one query-key factory, `const requirementKeys = { all, list(p), detail(p, k) }`. Source: [TkDodo: effective query keys](https://tkdodo.eu/blog/effective-react-query-keys), which the Query docs link.
- Give each resource one `queryOptions()` factory, and use it from both `useQuery` and `prefetchQuery`. Source: [Query: queryOptions](https://tanstack.com/query/latest/docs/framework/react/guides/query-options).
- A mutation updates the cache with `setQueryData` from its response, or invalidates with the key factory in `onSuccess`/`onSettled`. Source: [Query: invalidations from mutations](https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations).
- Never fetch inside `useEffect`, and never call `fetch` in a component. Server state comes from a query. Source: [React: fetching data](https://react.dev/learn/you-might-not-need-an-effect#fetching-data).
- Never copy server state into `useState`. Derive from `data`, and hold only the user's edit as local state. Source: [TkDodo: React Query and forms](https://tkdodo.eu/blog/react-query-and-forms).
- Use `select` to shape the data. Never transform it in an effect.

## TanStack Table and Virtual

- Columns come from `createColumnHelper<T>()`, and rows from the library's row models (`getCoreRowModel`, `getSortedRowModel`). Sources: [Table: column defs](https://tanstack.com/table/latest/docs/guide/column-defs) and [Table: row models](https://tanstack.com/table/latest/docs/guide/row-models).
- A list that can pass about 200 rows virtualises with `useVirtualizer`. Source: [Virtual: introduction](https://tanstack.com/virtual/latest/docs/introduction).
- Sort state lives in the URL, not in a table's own state.

## Charts

- Draw charts with Recharts inside the shadcn `ChartContainer` and its `ChartConfig`, with colours as `var(--chart-n)` or `var(--status-*-solid)`. Never draw a chart as a hand-made SVG. Source: [shadcn: chart](https://ui.shadcn.com/docs/components/chart).

## React

- Compute derived values during render, never in an effect.
  - ✗ `useEffect(() => setTotal(a + b), [a, b])`
  - ✓ `const total = a + b`
  - Source: [React: you might not need an effect](https://react.dev/learn/you-might-not-need-an-effect).
- Use an effect only to sync with something outside React: a socket, the DOM, a timer. Source: [React: synchronizing with effects](https://react.dev/learn/synchronizing-with-effects).
- To reset state when an id changes, use `key={id}`, not an effect. Source: [React: resetting state with a key](https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes).
- A list key is the item's stable id, never its index. A list without ids takes `useListKeys` (editable) or `keyedByContent` (read-only) from `@/design`. Source: [React: rendering lists](https://react.dev/learn/rendering-lists#keeping-list-items-in-order-with-key).
- The React Compiler is on (`reactCompiler` in `next.config.ts`). Write no `useMemo`, `useCallback` or `memo` for speed. Keep one only where an outside system needs a stable identity. Source: [React Compiler](https://react.dev/learn/react-compiler).
- Follow the Rules of Hooks and the Rules of React; lint checks both. Source: [React: rules](https://react.dev/reference/rules).

## State

- Filters, sort, the selected tab and the open peek go in URL search params (`useUrlParams`, `useUrlChoice` from `@/design`), so a view can be shared. Source: [Next: useSearchParams](https://nextjs.org/docs/app/api-reference/functions/use-search-params).
- Keep ephemeral UI state local: a hover, an open menu, a draft.
- Add no global store. Share server state through the query cache, and session state through the existing providers.

## Forms

- Build a form from `Field` plus `placeRefusals` (`@/lib/api/field-refusals`). Core's refusal is the source of truth, shown on the field it names.
- `Field` hands its id and descriptions to the design control inside it through context; a control of your own reads them with `useFieldControl()`.
- On the client, check only input shape (required, number, length). Never re-implement core's rules.
- Use no form library.

## Copy

- Every string lives in the feature's copy file, `src/lib/i18n/copy/<domain>.json`, and is read with `useCopy()`. Copy is English and stays inside the copy budget (`check-copy-budget`).
- The page reads as state: a row is a fact, 15 words or fewer, and never an instruction or an explanation.

## Styling

- Use only tokens and Tailwind scale values: `bg-surface`, `text-muted`, `border-line`, `p-3`, `text-13`. Source: [Tailwind: theme variables](https://tailwindcss.com/docs/theme).
- Use no hex, `rgb()` or `oklch()` literals, and no arbitrary values (`w-[13px]`, `bg-[var(--x)]`) in features. Source: [Tailwind: arbitrary values](https://tailwindcss.com/docs/adding-custom-styles#using-arbitrary-values), the escape hatch this rule closes.
- Surfaces are flat: radius 0, a hairline border or divider, and no shadow. Controls take `rounded-sm` or `rounded-md` (4–6px). Only overlays take `shadow-overlay`.
- Use no boxed card mosaic. Build hierarchy from type, space and hairlines.
- Size icons with `<Icon name=… />` from `@/design` (16px, stroke 1.5). Never import `lucide-react` directly.
- Rows are 36px high (`h-row`), and 44px on touch, where the token switches them.

## Accessibility

- The primitive provides the role, the keyboard support and the focus handling. Do not add ARIA it already sets. Source: [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/).
- Every icon-only button has an `aria-label`. Source: [APG: names and descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/).
- The keyboard reaches everything a pointer can, and focus is visible (`shadow-focus`).
- Never use a raw `<table>` or `<select>` in a feature. Use `Table` and `Select` from `@/design`.

## Errors and loading

- Use one set: `EmptyState`, `LoadingState` and `ErrorState` from `@/design`. Never write a local copy.
- Each page section has its own Suspense or loading boundary, so one slow read never blanks the page. Source: [React: Suspense](https://react.dev/reference/react/Suspense).
