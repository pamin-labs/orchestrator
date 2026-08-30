CREATE INDEX "event_kind" ON "event" ("kind","at");--> statement-breakpoint
CREATE INDEX "event_age" ON "event" ("at");--> statement-breakpoint
CREATE INDEX "job_agent" ON "job" ("agent_id","id");--> statement-breakpoint
CREATE INDEX "note_grp" ON "note" ("grp_id","at" DESC,"id" DESC);