CREATE TABLE "logs" (
	"id" bigserial NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"level" smallint NOT NULL,
	"service" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb NOT NULL,
	CONSTRAINT "logs_id_ts_pk" PRIMARY KEY("id","ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE INDEX "idx_logs_service_ts" ON "logs" USING btree ("service","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_level_ts" ON "logs" USING btree ("level","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_logs_attributes" ON "logs" USING gin ("attributes");--> statement-breakpoint
CREATE TABLE logs_default PARTITION OF logs DEFAULT;