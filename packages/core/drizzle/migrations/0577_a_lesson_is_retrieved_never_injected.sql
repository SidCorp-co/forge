-- A lesson is retrieved, never injected wholesale (ISS-867, owner rule prompt-is-a-map, 2026-11-01).
-- An approved lesson's knowledge entry `lesson-<n>` read `injection: always`, and every prompt in its
-- scope carried its sentence. A prompt now carries only the lessons map, the slugs, and the agent
-- reads the ones its work needs, so an approved lesson's entry is `on_demand`: what the field says
-- is what happens. A held or retired lesson stays `none`. Only a lesson's own entry is moved; a
-- month's figures (`lessons-month-<YYYY-MM>`, the same kind) are already `on_demand` or `none`.
--
-- ROLLBACK: UPDATE knowledge_entries SET injection = 'always'
--   WHERE kind = 'lesson' AND slug ~ '^lesson-[0-9]+$' AND injection = 'on_demand';

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
UPDATE knowledge_entries
   SET injection = 'on_demand', updated_at = now()
 WHERE kind = 'lesson'
   AND slug ~ '^lesson-[0-9]+$'
   AND injection = 'always';
