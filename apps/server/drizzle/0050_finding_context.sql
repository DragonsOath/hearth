CREATE TABLE `finding_acceptances` (
	`key` text PRIMARY KEY NOT NULL,
	`signature` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`accepted_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `findings` ADD `nature` text DEFAULT 'failure' NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `signature` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `repaired` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `returned_after_repair` integer DEFAULT false NOT NULL;