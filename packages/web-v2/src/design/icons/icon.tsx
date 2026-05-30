import {
  Activity, Archive, ArrowRight, Bell, Calendar, Check, ChevronDown,
  ChevronRight, ChevronsUpDown, Circle, Clock, Cpu, DollarSign, Filter,
  Folder, GitBranch, GitFork, Github, Inbox, LayoutGrid, Link as LinkIcon,
  List, Lock, type LucideIcon, Mail, Monitor, MoreHorizontal, Pause, Play,
  Plus, RotateCw, Rows3, Search, Server, Settings, Shield, Sparkles, Square,
  Star, Trash2, TriangleAlert, Workflow, X,
} from "lucide-react";

/* Semantic icon names (carried over from the prototype's Icon.jsx) mapped to
   the production Lucide set. Screens stay readable — `<Icon name="pipeline" />`
   — and the icon set is swappable in one place. */
const ICONS = {
  board: LayoutGrid,
  grid: LayoutGrid,
  list: List,
  rows: Rows3,
  pipeline: Workflow,
  server: Server,
  monitor: Monitor,
  activity: Activity,
  clock: Clock,
  search: Search,
  bell: Bell,
  plus: Plus,
  play: Play,
  pause: Pause,
  stop: Square,
  check: Check,
  x: X,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  chevronUpDown: ChevronsUpDown,
  more: MoreHorizontal,
  settings: Settings,
  rerun: RotateCw,
  fork: GitFork,
  branch: GitBranch,
  trash: Trash2,
  arrowRight: ArrowRight,
  agent: Sparkles,
  folder: Folder,
  calendar: Calendar,
  shield: Shield,
  cpu: Cpu,
  dollar: DollarSign,
  lock: Lock,
  mail: Mail,
  github: Github,
  dot: Circle,
  filter: Filter,
  inbox: Inbox,
  link: LinkIcon,
  star: Star,
  archive: Archive,
  alert: TriangleAlert,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 18, strokeWidth = 1.75, className, style }: IconProps) {
  const Cmp = ICONS[name] ?? Circle;
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} style={style} />;
}
