CREATE TABLE `media_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_deliveries` (
	`key` text NOT NULL,
	`channel_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`due_at` text NOT NULL,
	`error` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`key`, `channel_id`)
);
--> statement-breakpoint
CREATE TABLE `media_titles` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`data` text NOT NULL
);
