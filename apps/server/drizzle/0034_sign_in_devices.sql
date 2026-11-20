ALTER TABLE `owner` ADD `username` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `persistent` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `via_public` integer DEFAULT false NOT NULL;