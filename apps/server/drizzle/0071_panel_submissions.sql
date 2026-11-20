CREATE TABLE `panel_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`spec_id` text NOT NULL,
	`version` integer NOT NULL,
	`receipt` text NOT NULL,
	`url` text,
	`terms_version` integer NOT NULL,
	`sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `panel_submissions_spec` ON `panel_submissions` (`service_id`,`spec_id`);--> statement-breakpoint
ALTER TABLE `custom_panels` ADD `locked` integer DEFAULT false NOT NULL;