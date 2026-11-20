CREATE TABLE `workspace_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text,
	`at` text NOT NULL,
	`title` text NOT NULL,
	`choices` text NOT NULL,
	`decisions` text NOT NULL,
	`items` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspace_snapshots_workspace` ON `workspace_snapshots` (`workspace_id`,`at`);--> statement-breakpoint
ALTER TABLE `job_steps` ADD `item_id` text;--> statement-breakpoint
ALTER TABLE `job_steps` ADD `freed_bytes` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `workspace_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `snapshot_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `mode` text;