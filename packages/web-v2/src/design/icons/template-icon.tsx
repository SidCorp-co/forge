import type { TEMPLATE_ICONS } from "@forge/contracts/workflow-templates";
import {
  ArrowRight, Bell, CircleCheck, CircleDot, Circle, Cpu, Database, Diamond, Eye, Filter, Flag,
  Folder, GitBranch, GitMerge, Inbox, LogOut, type LucideIcon, Monitor, MousePointerClick, Play,
  RefreshCw, Send, Server, Square, SquareCheck, Table, Target, TriangleAlert, User, Clock, Zap,
} from "lucide-react";

export type TemplateIconKey = (typeof TEMPLATE_ICONS)[number];

/* One glyph per icon key a diagram template may name; a key added to the contract without one
   here fails the type check rather than rendering nothing. */
const TEMPLATE_ICON: Record<TemplateIconKey, LucideIcon> = {
  bolt: Zap,
  database: Database,
  user: User,
  diamond: Diamond,
  flag: Flag,
  target: Target,
  folder: Folder,
  "check-square": SquareCheck,
  bell: Bell,
  "arrow-right": ArrowRight,
  "check-circle": CircleCheck,
  circle: Circle,
  "circle-dot": CircleDot,
  monitor: Monitor,
  pointer: MousePointerClick,
  cpu: Cpu,
  "log-out": LogOut,
  "alert-triangle": TriangleAlert,
  "git-merge": GitMerge,
  stop: Square,
  "git-branch": GitBranch,
  server: Server,
  send: Send,
  inbox: Inbox,
  table: Table,
  filter: Filter,
  eye: Eye,
  refresh: RefreshCw,
  clock: Clock,
  play: Play,
};

export function TemplateIcon({ icon, size = 13 }: { icon: string; size?: number }) {
  const Glyph = TEMPLATE_ICON[icon as TemplateIconKey] ?? Circle;
  return <Glyph size={size} strokeWidth={2} aria-hidden />;
}
