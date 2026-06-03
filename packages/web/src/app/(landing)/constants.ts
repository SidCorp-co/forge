/**
 * Landing page data — derived from docs/VISION.md.
 *
 * Concept lock (VISION §1): Forge is the open-source AI-powered software
 * lifecycle platform. Powered by Claude Code, running on devices the
 * operator controls. Today: Build / Review / Launch / Maintain.
 * Roadmap: Idea / Spec / Design.
 */

import type { LucideIcon } from 'lucide-react';
import { Building2, Lock, Users } from 'lucide-react';

// VISION §3 audience tiers — primary 3 used as Why Forge tiles.
export interface AudienceTile {
  icon: LucideIcon;
  label: string;
  body: string;
}

export const audienceTiles: AudienceTile[] = [
  {
    icon: Building2,
    label: 'Operators delivering software to external customers',
    body: 'Agencies, dev shops, software-on-demand studios, founder-engineers running paid client work. Forge is your production line.',
  },
  {
    icon: Users,
    label: 'Internal teams managing software lifecycle',
    body: 'IT teams, platform teams, engineering teams running multiple projects. Forge unifies your delivery flow.',
  },
  {
    icon: Lock,
    label: 'Privacy-sensitive / regulated teams',
    body: 'Code and Claude credentials cannot leave your infrastructure. The server never holds Claude credentials by design.',
  },
];

// VISION §4 — 7-stage lifecycle. status reflects what ships today.
export interface LifecycleStage {
  name: string;
  status: 'today' | 'roadmap';
  description: string;
}

export const lifecycleStages: LifecycleStage[] = [
  { name: 'Idea', status: 'roadmap', description: 'Capture, validate, AI-assisted exploration' },
  { name: 'Spec', status: 'roadmap', description: 'AI-drafted PRD, acceptance criteria' },
  { name: 'Design', status: 'roadmap', description: 'UX mock generation, ADR drafting' },
  { name: 'Build', status: 'today', description: 'Plan → code via Claude Code, on your devices' },
  { name: 'Review', status: 'today', description: 'AI review, QA, human gates per stage' },
  { name: 'Launch', status: 'today', description: 'Deploy, release, announce' },
  { name: 'Maintain', status: 'today', description: 'Webhook → issue → pipeline. Sentry, Stripe, GitHub events become work' },
];

// Pipeline visualization steps (default 14-status; landing shows the 6 most
// recognizable transitions). Keeps the section honest without rendering all 14.
export interface PipelineStep {
  stage: string;
  from: string;
  to: string;
  delay: number;
  glyph?: string;
}

export const pipelineSteps: PipelineStep[] = [
  { stage: 'triage', from: 'open', to: 'confirmed', delay: 0.0 },
  { stage: 'clarify', from: 'confirmed', to: 'clarified', delay: 0.1 },
  { stage: 'plan', from: 'clarified', to: 'approved', delay: 0.2 },
  { stage: 'code', from: 'approved', to: 'developed', delay: 0.3 },
  { stage: 'review', from: 'developed', to: 'pass', delay: 0.4, glyph: '✓' },
  { stage: 'release', from: 'pass', to: 'main', delay: 0.5 },
];

// Architecture diagram nodes (used by landing-architecture).
export interface ArchNode {
  id: string;
  label: string;
  detail: string;
  emphasis?: boolean;
}

export const archNodes: ArchNode[] = [
  { id: 'browser', label: 'Browser / mobile', detail: 'Web dashboard, real-time stream' },
  { id: 'web', label: 'Web app', detail: 'Next.js App Router' },
  { id: 'core', label: 'Control plane', detail: 'Hono · Drizzle · pg-boss · ws · MCP', emphasis: true },
  { id: 'pg', label: 'Postgres', detail: 'state + jobs + pgvector' },
  { id: 'device', label: 'Your device', detail: 'Tauri GUI or CLI daemon' },
  { id: 'claude', label: 'Claude CLI', detail: 'spawned locally; tokens in OS keychain' },
];
