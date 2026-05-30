/* The design layer — presentational, data-agnostic. Components here never
   touch data; features wire data into them. Import from "@/design". */

// foundations
export { Icon, type IconName, type IconProps } from "./icons/icon";
export { STAGES, STAGE_INDEX, stageColor, type StageKey } from "./stages";
export {
  STATUS_META, HEALTH_META, AVATAR_HUE,
  type StatusKey, type HealthKey, type AvatarHue, type ColorMeta,
} from "./status";

// primitives
export { Button, type ButtonProps } from "./primitives/button";
export { StatusChip, type StatusChipProps } from "./primitives/status-chip";
export { MonoTag, type MonoTagProps } from "./primitives/mono-tag";
export { Avatar, type AvatarProps } from "./primitives/avatar";
export { ProjectMark, type ProjectMarkProps } from "./primitives/project-mark";
export { HealthDot, type HealthDotProps } from "./primitives/health-dot";
export { Stat, type StatProps } from "./primitives/stat";
export { Card, CardHeader, CardTitle, CardContent } from "./primitives/card";
export { Kicker } from "./primitives/kicker";
export { Kbd } from "./primitives/kbd";
export { Spinner, type SpinnerProps } from "./primitives/spinner";
export { Skeleton, type SkeletonProps } from "./primitives/skeleton";
export { ProgressBar, type ProgressBarProps } from "./primitives/progress-bar";
export { EmptyState, type EmptyStateProps } from "./primitives/empty-state";
export { ErrorState, type ErrorStateProps } from "./primitives/error-state";
export { LiveDot, type LiveDotProps } from "./primitives/live-dot";
export { Toast, type ToastView, type ToastTone } from "./primitives/toast";
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
export { Tabs, type TabsProps, type TabItem } from "./primitives/tabs";
export { Breadcrumb, type BreadcrumbProps, type Crumb } from "./primitives/breadcrumb";
export { Pagination, type PaginationProps } from "./primitives/pagination";
export { Collapsible, type CollapsibleProps } from "./primitives/collapsible";
export { Table, THead, TBody, TR, TH, TD } from "./primitives/table";

// patterns
export { PipelineTracker, type PipelineTrackerProps } from "./patterns/pipeline-tracker";
export { KanbanCard, type KanbanCardProps } from "./patterns/kanban-card";
export { NavRail, type NavRailProps, type NavItem } from "./patterns/nav-rail";
export { TopBar, type TopBarProps } from "./patterns/top-bar";
export { CommandPalette, type CommandPaletteProps, type Command } from "./patterns/command-palette";
export {
  NotificationsMenu, type NotificationsMenuProps, type NotificationItem,
} from "./patterns/notifications-menu";
export { StreamingText, type StreamingTextProps } from "./patterns/streaming-text";
export { Highlight, type HighlightProps } from "./patterns/highlight";
export { SlideOver, type SlideOverProps } from "./patterns/slide-over";
export { Menu, type MenuProps, type MenuItem } from "./patterns/menu";
export { RouteProgress } from "./patterns/route-progress";
export { ForgeMascot, type ForgeMascotProps, STAGE_RING } from "./patterns/forge-mascot";
export { ProjectLoader, ColdBoot, AgentWorking, ReconnectingBanner } from "./patterns/mascot-loaders";

// skeleton compositions
export {
  BoardRowSkeleton, KanbanCardSkeleton, KanbanColumnSkeleton,
  SessionRowSkeleton, ProjectCardSkeleton,
} from "./skeletons";

// hooks
export { useElapsed } from "./hooks/use-elapsed";
export { useAnimatedNumber } from "./hooks/use-animated-number";
