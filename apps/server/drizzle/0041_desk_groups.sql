CREATE TABLE `desk_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`search` text NOT NULL,
	`conversation_id` text,
	`view` text,
	`unsent` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
