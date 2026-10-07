-- A person's interface language is a choice they may not have made: `user_preferences.language` is
-- nullable, and null follows each project's content language. The column was a form field nothing
-- read, defaulting every row to 'en', so no stored 'en' is a choice anyone made; every row is reset
-- to null. A value outside en/vi is refused by name from here on.
--
-- ROLLBACK: UPDATE user_preferences SET language = 'en' WHERE language IS NULL; then SET DEFAULT 'en',
-- SET NOT NULL, and drop user_preferences_language_chk.

UPDATE "user_preferences" SET "language" = NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "language" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "language" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_language_chk" CHECK ("language" IS NULL OR "language" IN ('en', 'vi'));
