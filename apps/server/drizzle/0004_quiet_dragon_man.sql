CREATE TABLE `storage_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`label` text NOT NULL,
	`path` text NOT NULL,
	`source` text NOT NULL,
	`added_at` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
