-- A box names, on every heartbeat, each binary a pane needs that it cannot resolve (forge-runner,
-- claude, node), with what was looked for. Before this the daemon knew it and logged it at pane
-- start, and no screen could read it. Its own column for the reason gate_report has one: it is a
-- condition the box is IN, not something it declares it can do. NULL is a box that never reported.
--
-- ROLLBACK: ALTER TABLE devices DROP COLUMN binary_report.

ALTER TABLE "devices" ADD COLUMN "binary_report" jsonb;
