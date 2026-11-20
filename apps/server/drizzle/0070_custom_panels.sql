CREATE TABLE `custom_panels` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`spec_version` integer NOT NULL,
	`spec` text NOT NULL,
	`dropped` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`installed_at` text
);
--> statement-breakpoint
CREATE INDEX `custom_panels_service` ON `custom_panels` (`service_id`,`status`);