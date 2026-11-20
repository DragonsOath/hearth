CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`turns` integer,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	`conversation_id` text,
	`incident_id` text
);
--> statement-breakpoint
CREATE INDEX `ai_usage_day` ON `ai_usage` (`day`);--> statement-breakpoint
CREATE TABLE `jurisdiction` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`value` text,
	`access` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `evidence` text;--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `meta` text;