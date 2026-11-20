CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`message_id` integer,
	`mime` text NOT NULL,
	`data` blob NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`context` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_message` ON `attachments` (`conversation_id`,`message_id`);