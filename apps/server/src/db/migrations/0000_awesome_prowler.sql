CREATE TYPE "public"."chunk_state" AS ENUM('pending', 'fetching', 'buffered', 'committed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."file_state" AS ENUM('pending', 'downloading', 'uploading', 'verifying', 'completed', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."integrity_algorithm" AS ENUM('sha256', 'md5', 'crc32c');--> statement-breakpoint
CREATE TYPE "public"."job_mode" AS ENUM('copy', 'mirror', 'incremental', 'update_only');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'preparing', 'scanning', 'planning', 'running', 'paused', 'retrying', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."plan_action" AS ENUM('copy', 'skip', 'overwrite', 'rename', 'delete', 'archive');--> statement-breakpoint
CREATE TYPE "public"."provider_kind" AS ENUM('mega', 'gdrive');--> statement-breakpoint
CREATE TYPE "public"."upload_session_state" AS ENUM('open', 'completed', 'expired', 'aborted');--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"planner_version" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_file_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"byte_start" bigint NOT NULL,
	"byte_end" bigint NOT NULL,
	"state" "chunk_state" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"root_id" text,
	"root_path" text,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"inventory_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"is_folder" boolean DEFAULT false NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"checksum_algorithm" text,
	"checksum_value" text,
	"modified" timestamp with time zone,
	"mime" text,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "job_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"plan_entry_id" bigint,
	"state" "file_state" DEFAULT 'pending' NOT NULL,
	"source_node_id" text NOT NULL,
	"source_path" text NOT NULL,
	"dest_parent_id" text,
	"dest_file_id" text,
	"size_bytes" bigint NOT NULL,
	"chunk_size" integer,
	"committed_offset" bigint DEFAULT 0 NOT NULL,
	"integrity_algorithm" "integrity_algorithm" DEFAULT 'sha256' NOT NULL,
	"integrity_state" "bytea",
	"integrity_hex" text,
	"aux_md5_state" "bytea",
	"aux_md5_hex" text,
	"dest_checksum_hex" text,
	"verified" boolean,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claimed_by" text,
	"claim_heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_plan_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"action" "plan_action" NOT NULL,
	"source" jsonb NOT NULL,
	"dest_parent_id" text,
	"resolved_name" text,
	"dedup_basis" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_account_id" uuid NOT NULL,
	"dest_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"mode" "job_mode" DEFAULT 'copy' NOT NULL,
	"source_selection" jsonb NOT NULL,
	"dest_folder_id" text NOT NULL,
	"dest_folder_path" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_files" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"transferred_bytes" bigint DEFAULT 0 NOT NULL,
	"completed_files" integer DEFAULT 0 NOT NULL,
	"failed_files" integer DEFAULT 0 NOT NULL,
	"skipped_files" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"cloned_from_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"category" text NOT NULL,
	"job_id" uuid,
	"job_file_id" uuid,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"auth_blob" "bytea" NOT NULL,
	"auth_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"quota_total" bigint,
	"quota_used" bigint,
	"quota_checked_at" timestamp with time zone,
	"uploaded_24h" bigint DEFAULT 0 NOT NULL,
	"uploaded_24h_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "provider_kind" NOT NULL,
	"display_name" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_account_id" uuid NOT NULL,
	"dest_account_id" uuid NOT NULL,
	"source_selection" jsonb NOT NULL,
	"dest_folder_id" text NOT NULL,
	"dest_folder_path" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_file_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"session_uri" text NOT NULL,
	"state" "upload_session_state" DEFAULT 'open' NOT NULL,
	"last_offset" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"etag" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_plans" ADD CONSTRAINT "execution_plans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_job_file_id_job_files_id_fk" FOREIGN KEY ("job_file_id") REFERENCES "public"."job_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_entries" ADD CONSTRAINT "inventory_entries_inventory_id_inventories_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_files" ADD CONSTRAINT "job_files_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_plan_entries" ADD CONSTRAINT "job_plan_entries_plan_id_execution_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."execution_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_account_id_provider_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dest_account_id_provider_accounts_id_fk" FOREIGN KEY ("dest_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_source_account_id_provider_accounts_id_fk" FOREIGN KEY ("source_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_dest_account_id_provider_accounts_id_fk" FOREIGN KEY ("dest_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_job_file_id_job_files_id_fk" FOREIGN KEY ("job_file_id") REFERENCES "public"."job_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_user_unread" ON "events" USING btree ("user_id","created_at") WHERE "events"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_events_type_created" ON "events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "idx_ep_job" ON "execution_plans" USING btree ("job_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fc_file_index" ON "file_chunks" USING btree ("job_file_id","chunk_index");--> statement-breakpoint
CREATE INDEX "idx_fc_file_state" ON "file_chunks" USING btree ("job_file_id","state");--> statement-breakpoint
CREATE INDEX "idx_inv_account" ON "inventories" USING btree ("account_id","scanned_at");--> statement-breakpoint
CREATE INDEX "idx_ie_inventory_path" ON "inventory_entries" USING btree ("inventory_id","path");--> statement-breakpoint
CREATE INDEX "idx_ie_inventory_node" ON "inventory_entries" USING btree ("inventory_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jf_job_source" ON "job_files" USING btree ("job_id","source_node_id");--> statement-breakpoint
CREATE INDEX "idx_jf_job_state" ON "job_files" USING btree ("job_id","state");--> statement-breakpoint
CREATE INDEX "idx_jf_active" ON "job_files" USING btree ("state") WHERE "job_files"."state" IN ('pending','downloading','uploading','verifying');--> statement-breakpoint
CREATE INDEX "idx_jpe_plan" ON "job_plan_entries" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_active" ON "jobs" USING btree ("state") WHERE "jobs"."state" IN ('queued','preparing','scanning','planning','running','retrying');--> statement-breakpoint
CREATE INDEX "idx_jobs_user_created" ON "jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_logs_ts" ON "logs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "idx_logs_job" ON "logs" USING btree ("job_id","ts") WHERE "logs"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pa_user_provider_label" ON "provider_accounts" USING btree ("user_id","provider_id","label");--> statement-breakpoint
CREATE INDEX "idx_pa_user" ON "provider_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_due" ON "schedules" USING btree ("next_run_at") WHERE "schedules"."enabled" = true;--> statement-breakpoint
CREATE INDEX "idx_templates_user" ON "templates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_us_file" ON "upload_sessions" USING btree ("job_file_id");--> statement-breakpoint
CREATE INDEX "idx_us_open" ON "upload_sessions" USING btree ("state") WHERE "upload_sessions"."state" = 'open';