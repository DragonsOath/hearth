CREATE TABLE `watch_events` (
	`id` text PRIMARY KEY NOT NULL,
	`watch_id` text NOT NULL,
	`at` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`notify` text,
	`sent` text NOT NULL,
	FOREIGN KEY (`watch_id`) REFERENCES `watches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `watch_events_watch` ON `watch_events` (`watch_id`,`at`);--> statement-breakpoint
CREATE TABLE `watches` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`facts` text,
	`assessment` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_checked_at` text,
	`next_check_at` text,
	`check_error` text,
	`snoozed_until` text,
	`dismissed_at` text,
	`told` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watches_kind_key` ON `watches` (`kind`,`key`);--> statement-breakpoint
CREATE INDEX `watches_due` ON `watches` (`next_check_at`);