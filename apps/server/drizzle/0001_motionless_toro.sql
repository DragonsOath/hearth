CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`incident_id` text,
	`status` text NOT NULL,
	`requested_at` text NOT NULL,
	`completed_at` text,
	`result` text,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`incident_id` text NOT NULL,
	`summary` text NOT NULL,
	`outcome` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `autonomy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`description` text NOT NULL,
	`level` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`tone` text NOT NULL,
	`message` text NOT NULL,
	`incident_id` text,
	`host_id` text,
	`service_id` text,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`os` text NOT NULL,
	`address` text NOT NULL,
	`cpu_model` text NOT NULL,
	`cpu_cores` integer NOT NULL,
	`cpu_usage_pct` real NOT NULL,
	`mem_total_gb` real NOT NULL,
	`mem_used_gb` real NOT NULL,
	`uptime_hours` real NOT NULL,
	`connection` text NOT NULL,
	`docker` integer NOT NULL,
	`health` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `incident_timeline` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`incident_id` text NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` text NOT NULL,
	`resolved_at` text,
	`summary` text NOT NULL,
	`resolution` text,
	`handled_by` text NOT NULL,
	`proposed_action` text,
	`host_id` text,
	`service_id` text,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`instances` integer,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`description` text NOT NULL,
	`channels` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_dependencies` (
	`service_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`service_id`, `depends_on_id`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`host_id` text NOT NULL,
	`kind` text NOT NULL,
	`image` text,
	`version` text,
	`local_url` text NOT NULL,
	`public_url` text,
	`health` text NOT NULL,
	`response_ms` integer,
	`uptime_pct` real NOT NULL,
	`autonomy_area` text NOT NULL,
	`note` text,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`label` text NOT NULL,
	`mount` text NOT NULL,
	`kind` text NOT NULL,
	`total_tb` real NOT NULL,
	`used_tb` real NOT NULL,
	`smart` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
