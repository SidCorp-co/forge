-- Drop the `shop-*` Epodsystem storefront skill family entirely (owner request).
-- Hand-written data migration (applied from meta/_journal.json).
--
-- The `shop-` builtin prefix was removed from BUILTIN_SKILL_PREFIXES and the
-- ecommerce/blog/landing `website` domain-template seeds were deleted, so these
-- rows are no longer re-seeded on boot. Seeding only upserts (never prunes), so
-- the already-seeded rows must be removed explicitly here.
--
-- Covers BOTH scopes: the global templates AND any per-project clones a project
-- adopted (name LIKE 'shop-%'). skill_registrations.skill_id has ON DELETE
-- CASCADE, but we delete registrations first to be explicit/robust.

DELETE FROM "skill_registrations"
WHERE "skill_id" IN (SELECT "id" FROM "skills" WHERE "name" LIKE 'shop-%');

DELETE FROM "skills" WHERE "name" LIKE 'shop-%';

-- Remove the now-orphaned `website` domain templates that only wired shop-* skills.
DELETE FROM "domain_templates" WHERE "key" IN ('ecommerce', 'blog', 'landing');
