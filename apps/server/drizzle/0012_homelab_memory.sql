CREATE TABLE `backup_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`reason` text NOT NULL,
	`ok` integer NOT NULL,
	`file` text,
	`bytes` integer,
	`duration_ms` integer NOT NULL,
	`detail` text NOT NULL,
	`copied` integer
);
--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text,
	`happened_at` text NOT NULL,
	`basis` text DEFAULT 'unknown' NOT NULL,
	`machine` text,
	`verification` text,
	`source` text NOT NULL,
	`author` text,
	`links` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `memory_projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memory_entries_kind` ON `memory_entries` (`kind`,`happened_at`);--> statement-breakpoint
CREATE INDEX `memory_entries_project` ON `memory_entries` (`project_id`);--> statement-breakpoint
CREATE TABLE `memory_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` text NOT NULL,
	`at` text NOT NULL,
	`action` text NOT NULL,
	`by` text NOT NULL,
	`author` text,
	`snapshot` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `memory_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_revisions_entry` ON `memory_revisions` (`entry_id`);--> statement-breakpoint
CREATE TABLE `memory_transcript_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transcript_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`transcript_id`) REFERENCES `memory_transcripts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_transcript_messages_seq` ON `memory_transcript_messages` (`transcript_id`,`seq`);--> statement-breakpoint
CREATE TABLE `memory_transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`client` text NOT NULL,
	`title` text NOT NULL,
	`machine` text,
	`session_ref` text,
	`project_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `memory_projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_transcripts_session` ON `memory_transcripts` (`client`,`session_ref`);