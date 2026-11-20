CREATE TABLE `container_events` (
	`service_id` text NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`exit_code` integer,
	`oom_killed` integer,
	`restart_count` integer,
	`cause` text NOT NULL,
	`action_id` text,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`service_id`, `at`, `kind`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
