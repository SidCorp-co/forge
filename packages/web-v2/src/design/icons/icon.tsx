import {
  Activity, Archive, ArrowRight, Bell, BookOpen, Calendar, Check, ChevronDown,
  ChevronLeft, ChevronRight, ChevronsUpDown, Circle, CircleHelp, Clock, Command,
  Cpu, DollarSign, Filter, Folder, GitBranch, GitFork, Github, Inbox, Keyboard,
  LayoutGrid, Link as LinkIcon, List, Lock, LogOut, type LucideIcon, Mail,
  Menu as MenuIcon, Monitor, MoreHorizontal, PanelLeftClose, Pause, Pin, Play,
  Plus, RotateCw, Rows3, Search, Server, Settings, Shield, Sparkles, Square,
  Star, Trash2, TriangleAlert, Users, Workflow, X,
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
  users: Users,
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
  pin: Pin,
  book: BookOpen,
  panelLeft: PanelLeftClose,
  chevronLeft: ChevronLeft,
  keyboard: Keyboard,
  help: CircleHelp,
  command: Command,
  menu: MenuIcon,
  logOut: LogOut,
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
