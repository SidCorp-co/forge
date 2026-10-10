"use client";

// The five page templates. Each is a layout with named slots and nothing else: no data, no copy.
// A screen picks one, fills the slots with blocks, and owns only what goes in them.
// The title and the page's acts render into the top bar (PageTitle, TopBarActions).

import type { ReactNode } from "react";
import { DetailLayout, DetailPane } from "../patterns/detail-tabs";
import { KanbanBoard } from "../patterns/kanban-board";
import { ListLayout, ListToolbar } from "../patterns/list-page";
import { PageTitle } from "../primitives/heading";
import { TopBarActions } from "../primitives/top-bar-slot";

function Head({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <PageTitle>{title}</PageTitle>
      {actions ? <TopBarActions>{actions}</TopBarActions> : null}
    </>
  );
}

export interface ListPageProps {
  title: ReactNode;
  /** The one primary act, and a view switch: in the top bar. */
  actions?: ReactNode;
  /** ListSearch, ToolbarSelect and FilterChip children of the filter bar. */
  toolbar?: ReactNode;
  /** A PeekPanel while one row is open. */
  peek?: ReactNode;
  /** GroupedList or RowList, or an EmptyState / LoadingState / ErrorState. */
  children: ReactNode;
  testId?: string;
}

/** Records to scan and open: filter bar, list, peek beside it. */
export function ListPage({ title, actions, toolbar, peek, children, testId }: ListPageProps) {
  return (
    <div className="min-h-full bg-app" data-testid={testId}>
      <Head title={title} actions={actions} />
      {toolbar ? <ListToolbar>{toolbar}</ListToolbar> : null}
      <ListLayout peek={peek}>{children}</ListLayout>
    </div>
  );
}

export interface DetailPageProps {
  /** DetailHeader: back, key, title, state badge, primary act. */
  header: ReactNode;
  /** FactsRail of FactsGroup / Fact: the record's properties. */
  rail: ReactNode;
  railCollapsed?: boolean;
  /** What stands above the tabs: DetailMobileTitle, a progress or a WaitBanner. */
  lead?: ReactNode;
  /** DetailTabs, bound to the URL with useUrlTab. */
  tabs?: ReactNode;
  /** The open tab's name, for the pane's label. */
  label: string;
  /** The open tab's view: Sections, PropertyList, RowList. */
  children: ReactNode;
  testId?: string;
  dataKey?: string;
}

/** One record: header, the open tab's view, its facts in a rail. */
export function DetailPage({ header, rail, railCollapsed, lead, tabs, label, children, testId, dataKey }: DetailPageProps) {
  return (
    <div className="min-h-full bg-app" data-testid={testId}>
      {header}
      <DetailLayout rail={rail} railCollapsed={railCollapsed} dataKey={dataKey}>
        {lead}
        {tabs}
        <DetailPane label={label}>{children}</DetailPane>
      </DetailLayout>
    </div>
  );
}

export interface SettingsPageProps {
  title: ReactNode;
  actions?: ReactNode;
  /** In-page links to each group, beside the form from 1024px. */
  nav?: ReactNode;
  /** SettingsGroup of SettingRow, then FormActions. */
  children: ReactNode;
  testId?: string;
}

/** Configuration: groups of labelled controls in one readable column. */
export function SettingsPage({ title, actions, nav, children, testId }: SettingsPageProps) {
  return (
    <div className="min-h-full bg-app" data-testid={testId}>
      <Head title={title} actions={actions} />
      <div className="flex gap-10 px-8 py-6 max-md:px-4">
        {nav ? <nav className="sticky top-6 hidden w-48 flex-none self-start lg:block">{nav}</nav> : null}
        <div className="min-w-0 max-w-3xl flex-1">{children}</div>
      </div>
    </div>
  );
}

export interface BoardPageProps {
  title: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  /** KanbanColumn children, each holding KanbanCards. */
  children: ReactNode;
  testId?: string;
}

/** Work by stage: one column per stage, scrolled sideways. */
export function BoardPage({ title, actions, toolbar, children, testId }: BoardPageProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-app" data-testid={testId}>
      <Head title={title} actions={actions} />
      {toolbar ? <ListToolbar>{toolbar}</ListToolbar> : null}
      <div className="flex min-h-0 flex-1 px-5 py-4 max-md:px-3">
        <KanbanBoard>{children}</KanbanBoard>
      </div>
    </div>
  );
}

export interface ReportPageProps {
  title: ReactNode;
  actions?: ReactNode;
  /** The range and scope controls. */
  toolbar?: ReactNode;
  /** A StatRow of StatCells: the numbers first. */
  stats?: ReactNode;
  /** Sections, each a chart (ChartContainer) or a RowList. */
  children: ReactNode;
  testId?: string;
}

/** Numbers over time: the headline figures, then a section per chart. */
export function ReportPage({ title, actions, toolbar, stats, children, testId }: ReportPageProps) {
  return (
    <div className="min-h-full bg-app" data-testid={testId}>
      <Head title={title} actions={actions} />
      {toolbar ? <ListToolbar>{toolbar}</ListToolbar> : null}
      <div className="px-8 py-6 max-md:px-4">
        {stats ? <div className="mb-6">{stats}</div> : null}
        {children}
      </div>
    </div>
  );
}
