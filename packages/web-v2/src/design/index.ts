/* The design layer — presentational, data-agnostic. Components here never
   touch data; features wire data into them. Import from "@/design". */

export { Icon, type IconName, type IconProps } from "./icons/icon";
export { TemplateIcon, type TemplateIconKey } from "./icons/template-icon";
export { STAGES, stageColor, type StageKey } from "./stages";
export {
  STATUS_META, HEALTH_META, AVATAR_HUE, AGENT_TINT,
  type StatusKey, type HealthKey, type AvatarHue, type ColorMeta,
} from "./status";

export { Button, type ButtonProps } from "./primitives/button";
export { StatusChip, type StatusChipProps } from "./primitives/status-chip";
export { MonoTag, type MonoTagProps } from "./primitives/mono-tag";
export { Avatar, type AvatarProps } from "./primitives/avatar";
export { ProjectMark, type ProjectMarkProps } from "./primitives/project-mark";
export { HealthDot, type HealthDotProps } from "./primitives/health-dot";
export { Stat, type StatProps } from "./primitives/stat";
export { Card, CardHeader, CardTitle, CardContent } from "./primitives/card";
export { PageTitle, SectionTitle, type PageTitleProps } from "./primitives/heading";
export { TopBarActions, TopBarSlotProvider, useTopBarSlotTargets } from "./primitives/top-bar-slot";
export { Kicker } from "./primitives/kicker";
export { Kbd } from "./primitives/kbd";
export { Spinner, type SpinnerProps } from "./primitives/spinner";
export { Skeleton, type SkeletonProps } from "./primitives/skeleton";
export { ProgressBar, type ProgressBarProps } from "./primitives/progress-bar";
export { Sparkline, type SparklineProps } from "./primitives/sparkline";
export { Heartbeat, type HeartbeatProps, type HeartbeatDay } from "./primitives/heartbeat";
export { Waffle, type WaffleProps, type WaffleCategory } from "./primitives/waffle";
export { DotStrip, type DotStripProps, type DotStripItem } from "./primitives/dot-strip";
export { BulletBar, type BulletBarProps } from "./primitives/bullet-bar";
export { StreamBand, type StreamBandProps, type StreamWeek } from "./primitives/stream-band";
export { SankeyFlow, type SankeyFlowProps, type SankeyNode } from "./primitives/sankey-flow";
export { EmptyState, type EmptyStateProps } from "./primitives/empty-state";
export { EmptyPanelLine, type EmptyPanelLineProps } from "./primitives/empty-panel-line";
export { ComingSoon, type ComingSoonProps } from "./primitives/coming-soon";
export { ErrorState, type ErrorStateProps } from "./primitives/error-state";
export { LiveDot, type LiveDotProps } from "./primitives/live-dot";
export { Toaster, showToast, type ToastView, type ToastTone, type ToastInput } from "./primitives/toast";
export { Input, type InputProps } from "./primitives/input";
export { Field, type FieldProps } from "./primitives/field";
export { Toggle, type ToggleProps } from "./primitives/toggle";
export {
  SegmentedControl, type SegmentedControlProps, type SegmentOption,
} from "./primitives/segmented-control";
export { Textarea, type TextareaProps } from "./primitives/textarea";
export { Checkbox, type CheckboxProps } from "./primitives/checkbox";
export { Radio, RadioGroup, type RadioProps, type RadioGroupProps } from "./primitives/radio";
export {
  Select, NativeSelect, type SelectProps, type SelectOption, type NativeSelectProps,
} from "./primitives/select";
export { IconButton, type IconButtonProps } from "./primitives/icon-button";
export { Badge, type BadgeProps } from "./primitives/badge";
export { Divider, type DividerProps } from "./primitives/divider";
export { Banner, type BannerProps } from "./primitives/banner";
export { Tooltip, type TooltipProps } from "./primitives/tooltip";
export {
  Popover, type PopoverProps, type PopoverPlacement,
} from "./primitives/popover";
export { ConfirmDialog, type ConfirmDialogProps } from "./primitives/confirm-dialog";
export { Tabs, type TabsProps, type TabItem } from "./primitives/tabs";
export { ScreenTabs, type ScreenTabsProps } from "./patterns/screen-tabs";
export { PageContainer, type PageContainerProps } from "./patterns/page-container";
export { Pagination, type PaginationProps } from "./primitives/pagination";
export { Collapsible, type CollapsibleProps } from "./primitives/collapsible";
export {
  Table, THead, TBody, TR, TH, TD, SortableTH, DataTable,
  useReactTable, getCoreRowModel, getSortedRowModel, flexRender,
  type TableProps, type SortableTHProps, type DataTableProps, type ColumnDef, type SortingState, type OnChangeFn,
} from "./primitives/table";
export {
  HelpButton, type HelpButtonProps, type HelpContent, type HelpShortcut,
} from "./primitives/help-button";

export { KanbanCard, type KanbanCardProps } from "./patterns/kanban-card";
export { KanbanBoard, type KanbanBoardProps } from "./patterns/kanban-board";
export { KanbanColumn, type KanbanColumnProps } from "./patterns/kanban-column";
export { NavRail, type NavRailProps, type NavItem, type NavCluster, type NavEntry, type NavItemGroup } from "./patterns/nav-rail";
export { BottomTabBar, type BottomTabBarProps, type BottomTabItem } from "./patterns/bottom-tab-bar";
export { CommandPalette, type CommandPaletteProps, type Command, type CommandGroup } from "./patterns/command-palette";
export { PinnedTabBar, type PinnedTabBarProps, type PinnedTab } from "./patterns/pinned-tab-bar";
export {
  NotificationsMenu, type NotificationsMenuProps, type NotificationItem, type NotificationAction, type NotificationGroupMember,
} from "./patterns/notifications-menu";
export { StreamingText, type StreamingTextProps } from "./patterns/streaming-text";
export { Highlight, type HighlightProps } from "./patterns/highlight";
export { SlideOver, type SlideOverProps } from "./patterns/slide-over";
export { Menu, type MenuProps, type MenuItem } from "./patterns/menu";
export { HoverCard, type HoverCardProps, useHoverCard } from "./patterns/hover-card";
export { RouteProgress } from "./patterns/route-progress";
export { Markdown, type MarkdownProps } from "./patterns/markdown";
export { BodyView, type BodyViewProps } from "./patterns/body-view";
export { RecordCard, type RecordCardProps } from "./patterns/record-card";
export { PreviewPane, type PreviewPaneProps } from "./patterns/preview-pane";
export { HtmlArtifact, type HtmlArtifactProps } from "./patterns/html-artifact";
export { MermaidDiagram } from "./patterns/mermaid";
export { ForgeMascot, type ForgeMascotProps, STAGE_RING } from "./patterns/forge-mascot";
export { ProjectLoader, ColdBoot, AgentWorking, ReconnectingBanner } from "./patterns/mascot-loaders";

export {
  BoardRowSkeleton, KanbanCardSkeleton, KanbanColumnSkeleton,
  SessionRowSkeleton, ProjectCardSkeleton,
} from "./skeletons";

export { ToneBadge, StatusBadge, EnumBadge, type ToneBadgeProps, type StatusBadgeProps, type EnumBadgeProps } from "./primitives/enum-badge";
export {
  LEGEND, statusReading, enumLabel, sentenceCase, PRIORITY_BARS,
  type LegendTone, type StatusFamily, type EnumFamily, type StatusReading,
} from "./vocabulary";
export { WhoMark, PersonChip, AgentChip, ActorChip, type WhoKind } from "./patterns/person-chip";
export { WaitingOn, WaitBanner, type WaitingOnView, type BannerTone } from "./patterns/waiting-on";
export {
  GroupedList, useGroupFold, visibleRows, type ListGroup, type ListRowView, type GroupedListProps,
} from "./patterns/grouped-list";
export { PeekPanel, PeekHead, usePeek, usePeekKeys, type PeekState, type PeekPanelProps } from "./patterns/peek-panel";
export {
  DetailHeader, DetailMobileTitle, rememberListOrigin, useListOrigin, type DetailHeaderProps,
} from "./patterns/detail-header";
export {
  FactsRail, FactsGroup, Fact, FactsEmpty, CoverageBar, MarkStrip, StepBar,
  type CoverageSegment, type MarkView, type StepView,
} from "./patterns/facts-rail";
export { DetailTabs, DetailLayout, DetailPane, FieldLabel, useUrlTab, ViewHeading, type DetailTabItem } from "./patterns/detail-tabs";
export { ViewModeSwitcher, useViewMode, type ViewMode } from "./patterns/view-mode-switcher";
export { useUrlParams, useUrlChoice, writeUrlParams, type UrlPatch } from "./hooks/use-url-params";

export { useDebounced } from "./hooks/use-debounced";
export { useElapsed } from "./hooks/use-elapsed";
export { useNow } from "./hooks/use-now";
export { useAnimatedNumber } from "./hooks/use-animated-number";
export { useMediaQuery } from "./hooks/use-media-query";
export { useScrollLock } from "./hooks/use-scroll-lock";
