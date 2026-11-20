CREATE TABLE `disks` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`model` text NOT NULL,
	`type` text NOT NULL,
	`bus` text NOT NULL,
	`size_tb` real NOT NULL,
	`health` text NOT NULL,
	`temperature_c` real,
	`power_on_hours` integer,
	`wear_pct` real,
	`read_errors` integer,
	`write_errors` integer,
	`volumes` text NOT NULL,
	`checked_at` text NOT NULL,
	`limitation` text,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
