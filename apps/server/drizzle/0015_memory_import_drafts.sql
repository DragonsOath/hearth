CREATE TABLE `memory_import_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_ref` text NOT NULL,
	`batch` text NOT NULL,
	`origin` text NOT NULL,
	`anchor` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`decided_at` text,
	`result_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_import_drafts_source` ON `memory_import_drafts` (`source_ref`);--> statement-breakpoint
CREATE INDEX `memory_import_drafts_status` ON `memory_import_drafts` (`status`,`batch`);