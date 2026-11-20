CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`spec` text NOT NULL,
	`selections` text NOT NULL,
	`submission` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
