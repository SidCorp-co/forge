-- A box reports, on its heartbeat, what each filesystem it writes its runs' scratch into has left,
-- bytes and inodes. Before this the daemon judged the reading against thresholds of its own and
-- wrote it only to its local journal, so no screen and no part of core could see a box filling.
-- Core now holds the thresholds (devices/disk-report.ts). Its own column for the reason gate_report
-- has one: a condition the box is IN. NULL is a box that never reported.
--
-- ROLLBACK: ALTER TABLE devices DROP COLUMN disk_report.

ALTER TABLE "devices" ADD COLUMN "disk_report" jsonb;
