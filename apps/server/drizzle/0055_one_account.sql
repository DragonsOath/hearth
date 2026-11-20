CREATE TABLE `hub_link` (
	`id` integer PRIMARY KEY NOT NULL,
	`hub_url` text NOT NULL,
	`hub_name` text NOT NULL,
	`pc_id` text NOT NULL,
	`joined_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pair_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE TABLE `pcs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`os` text DEFAULT '' NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`install` text,
	`icon` text,
	`color` text,
	`joined_at` text NOT NULL,
	`last_seen_at` text
);
