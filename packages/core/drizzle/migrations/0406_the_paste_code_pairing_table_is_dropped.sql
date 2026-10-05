-- The paste-code pairing flow is removed end to end: POST /api/devices/pair (the redeemer),
-- POST /api/projects/:id/devices/pairing-codes (the minter, deleted in cleanup round 2) and the
-- runner's `login --code`. Device login (/api/devices/login/*) is the one pairing flow and keeps its
-- own table, device_login_codes.
--
-- ROLLBACK: none for the contents. pairing_codes held sha256 digests of one-use, short-lived codes
-- that nothing can mint any more, so an unredeemed row cannot be redeemed after this runs; the
-- table can be recreated empty from 0074/0404 and would hold nothing.
DROP TABLE "pairing_codes";
