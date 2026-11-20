CREATE TABLE `engine_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL,
	`at` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`meta` text,
	`task_id` integer
);
--> statement-breakpoint
CREATE INDEX `engine_messages_project` ON `engine_messages` (`project`,`id`);--> statement-breakpoint
CREATE TABLE `engine_projects` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `engine_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `engine_task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`at` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`actor` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `engine_task_events_task` ON `engine_task_events` (`task_id`,`id`);--> statement-breakpoint
CREATE TABLE `engine_task_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `engine_task_log_task` ON `engine_task_log` (`task_id`,`id`);--> statement-breakpoint
CREATE TABLE `engine_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`project` text NOT NULL,
	`engine` text NOT NULL,
	`model` text,
	`state` text NOT NULL,
	`position` real NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 2 NOT NULL,
	`needs_approval` integer DEFAULT 0 NOT NULL,
	`approval_reason` text,
	`approved_by` text,
	`approved_at` text,
	`session_id` text,
	`resume` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`exit_code` integer,
	`cost_usd` real,
	`source` text,
	`pid` integer,
	`conversation` integer DEFAULT 0 NOT NULL,
	`attachments` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`heartbeat_at` text
);
--> statement-breakpoint
CREATE INDEX `engine_tasks_state` ON `engine_tasks` (`state`,`position`);--> statement-breakpoint
CREATE TABLE `engine_usage` (
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`day`, `kind`)
);
