CREATE TABLE `conversation_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`ref` text,
	`at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
