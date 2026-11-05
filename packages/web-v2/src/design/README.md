# Page grammar

Everything here is imported from `@/design`. A feature never imports `@/components/ui/*`,
`@base-ui/react` or `lucide-react`. The coding rules are in [`../../CODE-STANDARD.md`](../../CODE-STANDARD.md).
Every piece on this page is rendered at `/dev/design`.

## Pick a template

| Template | Use it for | Slots | Blocks that fill them |
|---|---|---|---|
| `ListPage` + `useListPage` | records to scan and open | `title` `titleAfter` `actions` `lead` `toolbar` `peek` `children` | `ListSearch` `ToolbarSelect` `FilterChip` · `GroupedList` or `RowList` · `PeekPanel` + `PeekHead` + `PeekExcerpt`; `useListPage` holds the search, filters, groups, fold and peek in the URL |
| `DetailPage` | one record | `header` `rail` `lead` `tabs` `label` `children` | `DetailHeader` · `FactsRail` `FactsGroup` `Fact` · `DetailTabs` + `useUrlTab` · `Section` `PropertyList` `RowList` |
| `SettingsPage` | configuration | `title` `actions` `nav` `children` | `SettingsGroup` `SettingRow` `FormActions` · `Field` + `placeRefusals` |
| `BoardPage` | work by stage | `title` `actions` `toolbar` `children` | `KanbanColumn` `KanbanCard` |
| `ReportPage` | numbers over time | `title` `actions` `toolbar` `stats` `children` | `StatRow` `StatCell` · `Section` holding a chart (`ChartContainer`) or a `RowList` |

A page that fits none of the five is a design question, not a sixth layout. Ask before building one.

## Overlays

| Overlay | Use it for |
|---|---|
| `PeekPanel` | a list row's summary beside the list: what it says, then its facts; its full page a link (j/k, Enter, Esc) |
| `Dialog` | one decision or a short form that blocks the page |
| `ConfirmDialog` | a destructive or irreversible confirm |
| `SlideOver` | a longer side task that keeps the page in view |
| `Menu` | a row's or a page's acts |
| `Popover` / `HoverCard` / `Tooltip` | anchored detail: clicked, hovered, or a one-line name |
| `CommandPalette` | ⌘K; a screen's secondary acts reach it through `usePageCommands`, listed first under "This page" |
| `DetailDrawer` | a record's detail and Properties, opened from a quiet button into a SlideOver; never an inline rail |
| `showToast` | an act's outcome |

## Blocks

| Block | What it is |
|---|---|
| `GroupedList` | records grouped by where they stand, with folded groups and fixed columns |
| `GroupHeader` + `GROUP_ROW_INDENT` | a group's header in any grouped list, and the indent of the rows under it (see Grouping) |
| `TimelineFrame` / `TimelineHead` / `TimelineRow` / `TimelineTrack` / `TimelineMark` / `TimelineLegend` | lanes on one time axis: runs as bars, marks a page places (a numbered circle, a diamond, a pin) that open its popover |
| `RowList` / `RowItem` | a flush list: lead, title, facts, trailing; a hairline between items |
| `Section` | a flush heading, an act at its right, and a body. Never a card |
| `PropertyList` / `Property` | label and value rows in a main column |
| `FactsRail` / `FactsGroup` / `Fact` | label and value rows in a detail rail |
| `StatRow` / `StatCell` | headline numbers in one flush row; given `cells`, it wraps into even lines |
| `ContentsList` / `ContentsMenu` | a long page's groups: a list atop the facts rail marking the one in view, or one menu control where there is no rail |
| `SettingsGroup` / `SettingRow` / `FormActions` | labelled controls, a hint or a refusal under each, one save bar |
| `Disclosure` | a fold: label, count or summary, chevron |
| `CountSection` | a section shut by default: its label and count, opened on click; zero is a quiet line with nothing to open |
| `ExpandRows` / `ExpandRow` | one line per row that opens its detail in place; j/k move, Enter or Space opens, Escape shuts |
| `StatusChip` | a state in its legend tone, its reason on hover or keyboard focus (and to a screen reader) |
| `NextAction` | the screen's one primary act, in the top bar; a quiet "more" beside it opens the page's ⌘K acts |
| `EmptyState` / `LoadingState` / `ErrorState` | the three non-content states of any section |
| `StatusBadge` | a state family's value in its legend tone (`family="run"` for an agent run) |
| `EnumBadge` | a non-state enum (priority, kind), neutral |
| `ResizablePanelGroup` / `ResizablePanel` / `ResizableHandle` + `useRememberedSplit` | a split the reader drags, kept at the width they left it |
| `RailButton` | an act at the foot of the navigation rail: icon, name, a dot while something is owed |
| `fixedHeight(size, at)` | a scrolling region's viewport height by name: `pane`, `page`, `sticky`, `sheet`, `popup`, optionally from one width |
| `focusOnMount` | the ref callback for a field an act opens ready to type in, in place of `autoFocus` |
| `graph-canvas.css` | the skin every React Flow picture shares (the workflow canvas, the module map): import it beside the canvas |
| `RecordViewSwitch` + `useRecordView` | a record page's two readings, the person's state and the developer's agent text, in `?view=` (REQ-43 BC-7) |

## Grouping

Grouped data reads as a hierarchy, and stays flat (owner ruling `owner-2026-11-05-group-hierarchy`):

- Every group header is `GroupHeader`: a dot in the group's tone, a semibold label one step larger than its rows at full contrast, and its count as a small pill. A group that needs the person (tone `you`) takes amber.
- Its fold is a thin chevron after the count. It shows on hover or keyboard focus, and stays shown, turned, while the group is folded. Never a filled triangle before the label.
- The rows under it start under its label, 32px in (`GROUP_ROW_INDENT`), and so does a column header over them.
- No box and no tinted band: hierarchy comes from type, colour and the indent. A list that groups builds on `GroupedList` or the timeline's lanes, never a header of its own.

## Hooks

| Hook | What it gives |
|---|---|
| `useUrlParams` / `useUrlChoice` | filters, sort, tab and peek in the URL |
| `useNow(ms)` / `useElapsed(start)` | the time, from one shared clock per interval; never `Date.now()` in render |
| `useBrowserValue(read, server)` | a browser-only value (storage, `window`) without an effect |
| `useListKeys(n)` + `keyedRows` | stable keys for an editable list whose rows have no id |
| `keyedByContent` / `keyedNodes` | keys for a read-only list that never reorders |
| `useMediaQuery` | a media query, as a store |
| `useFieldControl` | the enclosing `Field`'s id and descriptions; the design controls read it already |

## Naming

- Name a component for what it shows: `IssueEvidence`, `RunOutcome`.
- Never name it after a layout: no new `*Row`, `*Section`, `*Card`, `*Panel` or `*Facts`. Such a name means a shared block is being copied.
- A missing block is added here under a plain name, and only after checking that the block does not already exist.

## Tokens

- **Scales:** `neutral`, `accent`, `ok`, `warn`, `danger`, `info`, `muted` and `ai`, steps 1–12, as `bg-neutral-3` or `text-danger-11`. Step roles:
  - 1–2: the two background layers;
  - 3–5: component background, hover, active;
  - 6–8: borders;
  - 9–10: solid;
  - 11–12: text.
- **Layers:** two, and only two. `bg-shell` is the base: a graphite under the shell's frame, its sidebar and the phone's nav drawer, nothing else, dark in both themes. `bg-app` is the content every page paints: the main pane, its rail, a docked panel. `bg-surface` is a bar or a control on that content, in the same tone, so the content stays flat. They are told apart by tone and a hairline, never by a frame or a shadow. Whatever sits on the base carries `data-layer="shell"`, which points the semantic aliases at the base's own `--shell-*` palette, so the same `text-muted` or `bg-hover` reads light on graphite. The neutrals are crisp grey, never a warm tint, and orange is the accent only.
- **Semantic:** reach for these first. They are `bg-shell`, `bg-app`, `bg-surface`, `bg-sunken`, `bg-hover`, `border-line-divider` (between rows, items and sections), `border-line-region` (between rail, content and peek), `border-line-subtle`, `border-line`, `border-line-strong`, `text-fg`, `text-muted`, `text-subtle`, `text-link`, `bg-accent`, `text-accent-text`, and `status-{ok,warn,danger,info,muted}-{bg,line,solid,fg}`.
- **Type:** `text-12` `text-13` `text-14` `text-16` `text-20` `text-24`, each with its line height.
  - Inter carries the UI and JetBrains Mono carries keys and code.
  - The classes `fg-h1`…`fg-caption` are the named steps.
- **Shape:** surfaces are radius 0. Controls take `rounded-sm` or `rounded-md`. Only overlays take `shadow-overlay`. Focus is `shadow-focus`. Rows are `h-row` (36px, 44px on touch).
