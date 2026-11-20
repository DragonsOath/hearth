CREATE TABLE `file_index` (
	`path` text PRIMARY KEY NOT NULL,
	`root_id` text NOT NULL,
	`host_id` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`modified_at` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`basis` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`gone_at` text
);
--> statement-breakpoint
CREATE INDEX `file_index_first_seen` ON `file_index` (`first_seen_at`);