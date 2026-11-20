CREATE TABLE `notification_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`event` text NOT NULL,
	`incident_id` text,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `config` text;--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `secret_id` text;