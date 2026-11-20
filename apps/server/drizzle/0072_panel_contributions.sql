CREATE TABLE `panel_agreements` (
	`service_id` text PRIMARY KEY NOT NULL,
	`terms_version` integer NOT NULL,
	`accepted_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `panel_baselines` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`origin` text NOT NULL,
	`spec` text NOT NULL,
	`spec_hash` text NOT NULL,
	`receipt` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `panel_baselines_service` ON `panel_baselines` (`service_id`);--> statement-breakpoint
ALTER TABLE `panel_submissions` ADD `spec_hash` text;--> statement-breakpoint
ALTER TABLE `panel_submissions` ADD `remote_id` text;--> statement-breakpoint
ALTER TABLE `panel_submissions` ADD `url_checked_at` text;--> statement-breakpoint
ALTER TABLE `custom_panels` DROP COLUMN `locked`;