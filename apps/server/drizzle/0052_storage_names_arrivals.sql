CREATE TABLE `volume_names` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mount` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `file_index` ADD `seen_after` text;--> statement-breakpoint
ALTER TABLE `file_index` ADD `moved_from` text;--> statement-breakpoint
ALTER TABLE `file_index` ADD `file_key` text;--> statement-breakpoint
ALTER TABLE `file_index` ADD `links` integer;--> statement-breakpoint
CREATE INDEX `file_index_file_key` ON `file_index` (`file_key`);