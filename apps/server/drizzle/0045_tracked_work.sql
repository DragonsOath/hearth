CREATE TABLE `tracked_work` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`machine` text NOT NULL,
	`status` text NOT NULL,
	`progress` real,
	`detail` text,
	`started_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`stop_by` text,
	`stall_minutes` integer DEFAULT 10 NOT NULL,
	`finished_at` text,
	`reported_by` text NOT NULL,
	`alerted` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tracked_work_status` ON `tracked_work` (`status`,`heartbeat_at`);