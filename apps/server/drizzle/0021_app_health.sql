CREATE TABLE `app_health` (
	`service_id` text PRIMARY KEY NOT NULL,
	`app` text NOT NULL,
	`status` text NOT NULL,
	`version` text,
	`issues` text NOT NULL,
	`facts` text NOT NULL,
	`detail` text,
	`checked_at` text NOT NULL,
	`failing_checks` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
