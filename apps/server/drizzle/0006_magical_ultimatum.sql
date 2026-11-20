CREATE TABLE `availability_hourly` (
	`service_id` text NOT NULL,
	`hour` text NOT NULL,
	`ok` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`service_id`, `hour`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `check_state` (
	`service_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`failing_since` text,
	`restart_count` integer,
	`detail` text,
	`checked_at` text NOT NULL,
	`last_ok_at` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `incidents` ADD `monitor_key` text;--> statement-breakpoint
ALTER TABLE `services` ADD `check_target` text;