export interface Section<Row> {
  key: string;
  label: string;
  rows: Row[];
}

interface DockRow {
  projectId: string;
  pinned?: boolean;
  kind?: string | null;
  subjectKey?: string | null;
}

/** Inside a section: the project's onboarding thread, then pinned rooms, then the rest as core sent them. */
function ordered<Row extends DockRow>(rows: Row[]): Row[] {
  const rank = (r: Row) => (r.kind === "onboarding" ? 0 : r.pinned ? 1 : 2);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

// the dock lists the open project's rooms as the prototype groups them, Project then This page
// (the rooms about the record this page shows), and any other project's rooms under that project's
// name, so a room from one project never reads as another's (REQ-11 BC-8)
export function dockSections<Row extends DockRow>(
  rows: Row[],
  opts: { projectId: string | null; pageKey: string | null; projectName: (id: string) => string },
): Array<Section<Row>> {
  const order = [...new Set([...(opts.projectId ? [opts.projectId] : []), ...rows.map((r) => r.projectId)])];
  return order.flatMap((pid) => {
    const own = rows.filter((r) => r.projectId === pid);
    if (pid !== opts.projectId) {
      return own.length ? [{ key: `project:${pid}`, label: opts.projectName(pid), rows: ordered(own) }] : [];
    }
    const page = own.filter((r) => opts.pageKey !== null && r.subjectKey === opts.pageKey);
    const project = own.filter((r) => !page.includes(r));
    return [
      ...(project.length ? [{ key: "project", label: "Project", rows: ordered(project) }] : []),
      ...(page.length ? [{ key: "page", label: "This page", rows: ordered(page) }] : []),
    ];
  });
}
