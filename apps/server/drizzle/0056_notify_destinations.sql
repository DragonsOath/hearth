ALTER TABLE `notification_channels` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `audience` text DEFAULT 'private' NOT NULL;