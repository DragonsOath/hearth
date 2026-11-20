ALTER TABLE `services` ADD `lifecycle` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `lifecycle_note` text;--> statement-breakpoint
ALTER TABLE `services` ADD `lifecycle_at` text;