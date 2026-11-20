CREATE TABLE `analyzer_runs` (
	`analyzer` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`checked_at` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`memo` text
);
--> statement-breakpoint
CREATE TABLE `finding_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` text NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `finding_events_finding` ON `finding_events` (`finding_id`,`id`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`key` text NOT NULL,
	`source` text NOT NULL,
	`analyzer` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`why` text NOT NULL,
	`next_steps` text NOT NULL,
	`evidence` text NOT NULL,
	`resources` text NOT NULL,
	`service_id` text,
	`host_id` text,
	`incident_id` text,
	`job_id` text,
	`todo_id` text,
	`conversation_id` text,
	`created_by` text NOT NULL,
	`sightings` integer DEFAULT 1 NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`checked_at` text NOT NULL,
	`resolved_at` text,
	`resolution` text,
	`snoozed_until` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`todo_id`) REFERENCES `todo_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_number` ON `findings` (`number`);--> statement-breakpoint
CREATE INDEX `findings_key` ON `findings` (`key`,`status`);--> statement-breakpoint
CREATE INDEX `findings_status` ON `findings` (`status`);--> statement-breakpoint
CREATE TABLE `volume_usage_daily` (
	`volume_id` text NOT NULL,
	`day` text NOT NULL,
	`used_tb` real NOT NULL,
	`total_tb` real NOT NULL,
	PRIMARY KEY(`volume_id`, `day`),
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE cascade
);
