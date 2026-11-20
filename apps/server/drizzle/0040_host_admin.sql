CREATE TABLE `capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`version` text,
	`source` text,
	`location` text,
	`purpose` text,
	`gap` text,
	`task` text,
	`conversation_id` text,
	`job_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `host_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`operations` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`revoked_at` text
);
