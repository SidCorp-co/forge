# The navigation rail has no links

Seen by judge-170 on ISS-1229 round 54, and not built there. The rail's rows, in
`design/patterns/nav-rail.tsx` and `features/shell/nav-rail-compact.tsx`, are buttons that call `onNavigate`, never
an `<a href>`. So a person cannot open a page in a new tab, by a middle-click, a modifier-click or the browser's menu,
and a screen reader announces each row as a button rather than a link.
