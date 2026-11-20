PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`host_id` text NOT NULL,
	`kind` text NOT NULL,
	`image` text,
	`version` text,
	`local_url` text,
	`public_url` text,
	`proxy_service_id` text,
	`health` text NOT NULL,
	`response_ms` integer,
	`uptime_pct` real NOT NULL,
	`autonomy_area` text NOT NULL,
	`note` text,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_services`("id", "name", "category", "host_id", "kind", "image", "version", "local_url", "public_url", "proxy_service_id", "health", "response_ms", "uptime_pct", "autonomy_area", "note", "sort") SELECT "id", "name", "category", "host_id", "kind", "image", "version", "local_url", "public_url", NULL, "health", "response_ms", "uptime_pct", "autonomy_area", "note", "sort" FROM `services`;--> statement-breakpoint
DROP TABLE `services`;--> statement-breakpoint
ALTER TABLE `__new_services` RENAME TO `services`;--> statement-breakpoint
PRAGMA foreign_keys=ON;