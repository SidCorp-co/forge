# Page grammar

Everything here is imported from `@/design`. A feature never imports `@/components/ui/*`,
`@base-ui/react` or `lucide-react`. The coding rules are in [`../../CODE-STANDARD.md`](../../CODE-STANDARD.md).
Every piece on this page is rendered at `/dev/design`.

## Pick a template

| Template | Use it for | Slots | Blocks that fill them |
|---|---|---|---|
| `ListPage` + `useListPage` | records to scan and open | `title` `titleAfter` `actions` `lead` `toolbar` `peek` `children` | `ListSearch` `ToolbarSelect` `FilterChip` · `GroupedList` or `RowList` · `PeekPanel` + `PeekHead`; `useListPage` holds the search, filters, groups, fold and peek in the URL |
| `DetailPage` | one record | `header` `rail` `lead` `tabs` `label` `children` | `DetailHeader` · `FactsRail` `FactsGroup` `Fact` · `DetailTabs` + `useUrlTab` · `Section` `PropertyList` `RowList` |
| `SettingsPage` | configuration | `title` `actions` `nav` `children` | `SettingsGroup` `SettingRow` `FormActions` · `Field` + `placeRefusals` |
| `BoardPage` | work by stage | `title` `actions` `toolbar` `children` | `KanbanColumn` `KanbanCard` |
| `ReportPage` | numbers over time | `title` `actions` `toolbar` `stats` `children` | `StatRow` `StatCell` · `Section` holding a chart (`ChartContainer`) or a `RowList` |

A page that fits none of the five is a design question, not a sixth layout. Ask before building one.

## Overlays

| Overlay | Use it for |
|---|---|
| `PeekPanel` | a list row's summary beside the list (j/k, Enter, Esc) |
| `Dialog` | one decision or a short form that blocks the page |
| `ConfirmDialog` | a destructive or irreversible confirm |
| `SlideOver` | a longer side task that keeps the page in view |
| `Menu` | a row's or a page's acts |
| `Popover` / `HoverCard` / `Tooltip` | anchored detail: clicked, hovered, or a one-line name |
| `CommandPalette` | ⌘K |
| `showToast` | an act's outcome |

## Blocks

| Block | What it is |
|---|---|
| `GroupedList` | records grouped by where they stand, with folded groups and fixed columns |
| `RowList` / `RowItem` | a flush list: lead, title, facts, trailing; a hairline between items |
| `Section` | a flush heading, an act at its right, and a body. Never a card |
| `PropertyList` / `Property` | label and value rows in a main column |
| `FactsRail` / `FactsGroup` / `Fact` | label and value rows in a detail rail |
| `StatRow` / `StatCell` | headline numbers in one flush row |
| `SettingsGroup` / `SettingRow` / `FormActions` | labelled controls, a hint or a refusal under each, one save bar |
| `Disclosure` | a fold: label, count or summary, chevron |
| `EmptyState` / `LoadingState` / `ErrorState` | the three non-content states of any section |
| `StatusBadge` | a state family's value in its legend tone (`family="run"` for an agent run) |
| `EnumBadge` | a non-state enum (priority, kind), neutral |
| `ResizablePanelGroup` / `ResizablePanel` / `ResizableHandle` | a split the reader drags |
| `RailButton` | an act at the foot of the navigation rail: icon, name, a dot while something is owed |
| `fixedHeight(size, at)` | a scrolling region's viewport height by name: `pane`, `page`, `sticky`, `sheet`, `popup`, optionally from one width |

## Naming

- Name a component for what it shows: `IssueEvidence`, `RunOutcome`.
- Never name it after a layout: no new `*Row`, `*Section`, `*Card`, `*Panel` or `*Facts`. Such a name means a shared block is being copied.
- A missing block is added here under a plain name, and only after checking that the block does not already exist.

## Tokens

- **Scales:** `neutral`, `accent`, `ok`, `warn`, `danger`, `info`, `muted` and `ai`, steps 1–12, as `bg-neutral-3` or `text-danger-11`. Step roles:
  - 1–2: app background;
  - 3–5: component background, hover, active;
  - 6–8: borders;
  - 9–10: solid;
  - 11–12: text.
- **Semantic:** reach for these first. They are `bg-app`, `bg-surface`, `bg-sunken`, `bg-hover`, `border-line-subtle`, `border-line`, `border-line-strong`, `text-fg`, `text-muted`, `text-subtle`, `text-link`, `bg-accent`, `text-accent-text`, and `status-{ok,warn,danger,info,muted}-{bg,line,solid,fg}`.
- **Type:** `text-12` `text-13` `text-14` `text-16` `text-20` `text-24`, each with its line height.
  - Inter carries the UI and JetBrains Mono carries keys and code.
  - The classes `fg-h1`…`fg-caption` are the named steps.
- **Shape:** surfaces are radius 0. Controls take `rounded-sm` or `rounded-md`. Only overlays take `shadow-overlay`. Focus is `shadow-focus`. Rows are `h-row` (36px, 44px on touch).
