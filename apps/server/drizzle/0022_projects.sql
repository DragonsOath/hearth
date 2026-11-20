CREATE TABLE `project_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` text NOT NULL,
	`done_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `memory_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_tasks_project` ON `project_tasks` (`project_id`,`seq`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `memory_projects` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `memory_projects` ADD `icon` text;--> statement-breakpoint
ALTER TABLE `memory_projects` ADD `related` text DEFAULT '[]' NOT NULL;