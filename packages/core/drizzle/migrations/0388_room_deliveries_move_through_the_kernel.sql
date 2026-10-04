-- ISS-167: a comment carried into a chat room and a question round posted there settle through the
-- kernel transition, so each row carries the uuid id a kernel_transitions record names, and each
-- status column's CHECK holds its machine's states. A row outside them aborts the migration.
ALTER TABLE "rocketchat_comment_mirrors" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "rocketchat_comment_mirrors" ADD CONSTRAINT "rcq_mirrors_id_key" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "rocketchat_comment_mirrors" ADD CONSTRAINT "rcq_mirrors_status_chk" CHECK ("rocketchat_comment_mirrors"."status" IN ('claimed', 'delivered', 'refused'));--> statement-breakpoint
ALTER TABLE "rocketchat_question_deliveries" ADD CONSTRAINT "rcq_deliveries_status_chk" CHECK ("rocketchat_question_deliveries"."status" IN ('claimed', 'delivered', 'undeliverable'));
