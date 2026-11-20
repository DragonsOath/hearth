CREATE TABLE `job_steps` (
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`service_id` text NOT NULL,
	`service_name` text NOT NULL,
	`label` text NOT NULL,
	`policy` text NOT NULL,
	`policy_reason` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`result` text,
	`action_id` text,
	PRIMARY KEY(`job_id`, `seq`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`reason` text,
	`requested_by` text NOT NULL,
	`incident_id` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	`approved_at` text,
	`started_at` text,
	`finished_at` text,
	`summary` text,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`,`created_at`);