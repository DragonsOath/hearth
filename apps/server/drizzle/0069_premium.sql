CREATE TABLE `premium_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`hint` text NOT NULL,
	`campaign` text,
	`audience` text DEFAULT 'other' NOT NULL,
	`note` text,
	`scope` text NOT NULL,
	`duration_days` integer,
	`expires_at` text,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `premium_codes_hash_unique` ON `premium_codes` (`hash`);--> statement-breakpoint
CREATE TABLE `premium_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient` text NOT NULL,
	`audience` text DEFAULT 'other' NOT NULL,
	`note` text,
	`scope` text NOT NULL,
	`kind` text DEFAULT 'complimentary' NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text,
	`install_id` text,
	`license_id` text,
	`code_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `premium_grants_install` ON `premium_grants` (`install_id`);--> statement-breakpoint
CREATE TABLE `premium_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`code_id` text NOT NULL,
	`install_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `premium_redemptions_once` ON `premium_redemptions` (`code_id`,`install_id`);