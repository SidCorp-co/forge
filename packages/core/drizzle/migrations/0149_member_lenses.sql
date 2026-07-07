-- Role-aware chat: soft "working lens(es)" assigned to an org member by an
-- owner/admin, orthogonal to the permission `role`. Shapes ONLY how the
-- interactive agent answers (altitude/voice), never permissions. Multi-valued
-- (text[]); values 'technical' | 'product' validated at the app layer. Empty
-- default = current behaviour (product / non-technical voice) — additive & safe
-- for existing rows.
ALTER TABLE "organization_members" ADD COLUMN IF NOT EXISTS "lenses" text[] DEFAULT ARRAY[]::text[] NOT NULL;
