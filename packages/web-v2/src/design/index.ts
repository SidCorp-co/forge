/* The design layer — presentational, data-agnostic. Components here never
   touch data; features wire data into them. Import from "@/design". */

export { Icon, type IconName } from "./icons/icon";
export { TemplateIcon } from "./icons/template-icon";
export { STAGES } from "./stages";
export { AGENT_TINT, type HealthKey, type AvatarHue } from "./status";

export { Button, SecondaryRegion } from "./primitives/button";
export { StatusChip } from "./primitives/status-chip";
export { MonoTag } from "./primitives/mono-tag";
export { Avatar } from "./primitives/avatar";
export { ProjectMark } from "./primitives/project-mark";
export { HealthDot } from "./primitives/health-dot";
export { Stat } from "./primitives/stat";
export { PageSection, PageSectionHeader, PageSectionTitle, PageSectionBody } from "./primitives/page-section";
export { PageTitle, SectionTitle } from "./primitives/heading";
export { TopBarActions, TopBarSlotProvider, useTopBarSlotTargets } from "./primitives/top-bar-slot";
export { Kicker } from "./primitives/kicker";
export { Kbd } from "./primitives/kbd";
export { Spinner } from "./primitives/spinner";
export { Skeleton } from "./primitives/skeleton";
export { ProgressBar } from "./primitives/progress-bar";
export { Sparkline } from "./primitives/sparkline";
export { Heartbeat } from "./primitives/heartbeat";
export { Waffle } from "./primitives/waffle";
export { DotStrip } from "./primitives/dot-strip";
export { BulletBar } from "./primitives/bullet-bar";
export { StreamBand } from "./primitives/stream-band";
export { SankeyFlow } from "./primitives/sankey-flow";
export { EmptyState } from "./primitives/empty-state";
export { EmptyPanelLine } from "./primitives/empty-panel-line";
export { ErrorState } from "./primitives/error-state";
export { LiveDot } from "./primitives/live-dot";
export { showToast, type ToastView } from "./primitives/toast";
export { Input } from "./primitives/input";
export { Field } from "./primitives/field";
export { Toggle } from "./primitives/toggle";
export { SegmentedControl, type SegmentOption } from "./primitives/segmented-control";
export { Textarea } from "./primitives/textarea";
export { Checkbox } from "./primitives/checkbox";
export { Radio, RadioGroup } from "./primitives/radio";
export { Select, NativeSelect, type SelectOption } from "./primitives/select";
export { IconButton } from "./primitives/icon-button";
export { Badge, type BadgeProps } from "./primitives/badge";
export { Divider } from "./primitives/divider";
export { Banner } from "./primitives/banner";
export { Tooltip } from "./primitives/tooltip";
export { Popover } from "./primitives/popover";
export { ConfirmDialog } from "./primitives/confirm-dialog";
export { Tabs, type TabItem } from "./primitives/tabs";
export { ScreenTabs } from "./patterns/screen-tabs";
export { PageContainer } from "./patterns/page-container";
export { Pagination } from "./primitives/pagination";
export { Collapsible } from "./primitives/collapsible";
export { Table, THead, TBody, TR, TH, TD, SortableTH, useReactTable, getCoreRowModel, type ColumnDef, type SortingState } from "./primitives/table";
export { HelpButton } from "./primitives/help-button";

export { KanbanCard } from "./patterns/kanban-card";
export { KanbanBoard } from "./patterns/kanban-board";
export { KanbanColumn } from "./patterns/kanban-column";
export { NavRail, isNavGroup, type NavEntry, type NavItem, type NavItemGroup } from "./patterns/nav-rail";
export { BottomTabBar, type BottomTabItem } from "./patterns/bottom-tab-bar";
export { CommandPalette, type Command } from "./patterns/command-palette";
export { PinnedTabBar } from "./patterns/pinned-tab-bar";
export { NotificationsMenu, type NotificationItem, type NotificationAction, type NotificationGroupMember } from "./patterns/notifications-menu";
export { StreamingText } from "./patterns/streaming-text";
export { SlideOver } from "./patterns/slide-over";
export { Menu, type MenuItem } from "./patterns/menu";
export { HoverCard, useHoverCard } from "./patterns/hover-card";
export { Markdown } from "./patterns/markdown";
export { BodyView } from "./patterns/body-view";
export { PreviewPane } from "./patterns/preview-pane";
export { HtmlArtifact } from "./patterns/html-artifact";
export { ForgeMascot } from "./patterns/forge-mascot";
export { ProjectLoader } from "./patterns/mascot-loaders";

export { BoardRowSkeleton, KanbanColumnSkeleton, SessionRowSkeleton, ProjectCardSkeleton } from "./skeletons";

export { ToneBadge, StatusBadge, EnumBadge } from "./primitives/enum-badge";
export { LEGEND, statusReading, enumLabel, sentenceCase, type LegendTone, type StatusFamily } from "./vocabulary";
export { WhoMark, PersonChip, ActorChip } from "./patterns/person-chip";
export { WaitingOn, WaitBanner, type WaitingOnView, type BannerTone } from "./patterns/waiting-on";
export { GroupedList, useGroupFold, visibleRows, standingGroups, type ListGroup, type ListRowView } from "./patterns/grouped-list";
export { ListSearch } from "./patterns/list-search";
export { FilterChip } from "./patterns/filter-chip";
export { SignalsStrip, Signal } from "./patterns/signals-strip";
export { NotAvailable } from "./patterns/not-available";
export { PeekPanel, PeekHead, usePeek, usePeekKeys, type PeekState } from "./patterns/peek-panel";
export { DetailHeader, DetailMobileTitle, rememberListOrigin, useListOrigin } from "./patterns/detail-header";
export {
  FactsRail, FactsGroup, Fact, FactsEmpty, CoverageBar, MarkStrip, StepBar,
  type CoverageSegment, type MarkView, type StepView,
} from "./patterns/facts-rail";
export { DetailTabs, DetailLayout, DetailPane, FieldLabel, useUrlTab, ViewHeading } from "./patterns/detail-tabs";
export { ViewModeSwitcher, useViewMode, type ViewMode } from "./patterns/view-mode-switcher";
export { useUrlParams, useUrlChoice } from "./hooks/use-url-params";

export { useDebounced } from "./hooks/use-debounced";
export { useElapsed } from "./hooks/use-elapsed";
export { useNow } from "./hooks/use-now";
export { useMediaQuery } from "./hooks/use-media-query";
