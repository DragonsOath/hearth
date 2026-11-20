CREATE TABLE `todo_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`conversation_id` text,
	FOREIGN KEY (`item_id`) REFERENCES `todo_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `todo_events_item` ON `todo_events` (`item_id`,`id`);--> statement-breakpoint
CREATE TABLE `todo_items` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text NOT NULL,
	`status` text NOT NULL,
	`services` text DEFAULT '[]' NOT NULL,
	`project_id` text,
	`evidence` text DEFAULT '[]' NOT NULL,
	`next_action` text,
	`conversation_id` text,
	`job_ids` text DEFAULT '[]' NOT NULL,
	`source` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`saved_at` text,
	`resolved_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `memory_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_items_number` ON `todo_items` (`number`);--> statement-breakpoint
CREATE INDEX `todo_items_status` ON `todo_items` (`status`);