-- Manual / user-invocable utility skills force-synced to runners WITHOUT a
-- pipeline-stage binding. When true, the project skill enters the device sync
-- manifest (resolveRegisteredEffectiveSkills) so forge_skills.push delivers it
-- to runner disk; the dispatcher still keys off skill_registrations, so the
-- skill is never auto-run. Additive + NOT NULL DEFAULT false → existing rows
-- read false (= normal stage-registered behaviour).
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "install_only" boolean DEFAULT false NOT NULL;
