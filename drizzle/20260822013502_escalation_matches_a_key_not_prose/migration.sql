ALTER TABLE "escalation" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "escalation" ADD COLUMN "question_said" jsonb;--> statement-breakpoint
ALTER TABLE "escalation" ADD COLUMN "brief_said" jsonb;--> statement-breakpoint
-- Backfill. Four subjects were matched by the opening line of "question", and
-- these four literals are what every stored row holds -- the prefixes were
-- deliberately left untranslated so the matchers kept working, so the mapping is
-- deterministic. It is also known for the last time here: after this commit the
-- prose is free to change and no regex over it would be right again.
UPDATE "escalation" SET "dedupe_key" = 'budget' WHERE "question" LIKE 'budget:%';--> statement-breakpoint
UPDATE "escalation" SET "dedupe_key" = 'pr-closed:' || substring("question" from '^PR #([0-9]+) 被关掉了')
  WHERE "question" ~ '^PR #[0-9]+ 被关掉了';--> statement-breakpoint
UPDATE "escalation" SET "dedupe_key" = 'auth:' || substring("question" from '^([^ ]+) 的凭据')
  WHERE "question" ~ '^[^ ]+ 的凭据';--> statement-breakpoint
UPDATE "escalation" SET "dedupe_key" = 'github:' || substring("question" from '^GitHub ([^:]+): ')
  WHERE "question" ~ '^GitHub [^:]+: ';
