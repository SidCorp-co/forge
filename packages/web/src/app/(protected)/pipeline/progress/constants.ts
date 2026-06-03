import type { IssueStatus } from '@/features/issue/types';
import {
  Inbox,
  Filter,
  CheckCircle,
  Code,
  Rocket,
  Eye,
  Flag,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';

export interface PipelineStage {
  key: string;
  label: string;
  statuses: IssueStatus[];
  icon: LucideIcon;
  color: string;
  bg: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { key: 'intake', label: 'Intake', statuses: ['open', 'needs_info'], icon: Inbox, color: 'border-blue-500', bg: 'bg-blue-500/5' },
  { key: 'triage', label: 'Triage', statuses: ['confirmed', 'clarified', 'waiting'], icon: Filter, color: 'border-indigo-500', bg: 'bg-indigo-500/5' },
  { key: 'approved', label: 'Ready', statuses: ['approved'], icon: CheckCircle, color: 'border-cyan-500', bg: 'bg-cyan-500/5' },
  { key: 'development', label: 'Development', statuses: ['in_progress', 'developed'], icon: Code, color: 'border-yellow-500', bg: 'bg-yellow-500/5' },
  { key: 'deploy_test', label: 'Deploy & Test', statuses: ['deploying', 'testing', 'tested', 'pass'], icon: Rocket, color: 'border-orange-500', bg: 'bg-orange-500/5' },
  { key: 'review', label: 'Review', statuses: ['staging'], icon: Eye, color: 'border-purple-500', bg: 'bg-purple-500/5' },
  { key: 'released', label: 'Released', statuses: ['released'], icon: Flag, color: 'border-green-400', bg: 'bg-green-400/5' },
  { key: 'done', label: 'Done', statuses: ['closed'], icon: Flag, color: 'border-green-500', bg: 'bg-green-500/5' },
  { key: 'blocked', label: 'Blocked', statuses: ['reopen', 'on_hold'], icon: AlertTriangle, color: 'border-red-500', bg: 'bg-red-500/5' },
];

export const STEP_LABELS: Record<string, string> = {
  'open→confirmed': 'Triage',
  'confirmed→clarified': 'Clarify',
  'waiting→approved': 'Approval',
  'clarified→approved': 'Approval',
  'approved→in_progress': 'Start Dev',
  'in_progress→developed': 'Development',
  'developed→deploying': 'Deploy',
  'deploying→testing': 'Deploy Wait',
  'testing→tested': 'Testing',
  'tested→pass': 'QA Pass',
  'pass→staging': 'Promote',
  'staging→released': 'Release',
  'released→closed': 'Close',
  'reopen→in_progress': 'Fix Loop',
};

export const OUTLIER_MULTIPLIER = 2;

export const TIME_WINDOWS = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
] as const;

// Hours before an issue is flagged as bottlenecked in each stage.
// Fractional values are allowed for sub-hour stages (e.g. 0.16 ≈ 10 min).
export const BOTTLENECK_THRESHOLDS: Record<string, number> = {
  intake: 24,
  triage: 12,
  approved: 48,
  development: 24,
  deploy_test: 12,
  review: 24,
  released: 0.16,
  blocked: 4,
};
