CREATE TABLE `movie_nights` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`starts_at` text NOT NULL,
	`time_zone` text NOT NULL,
	`spots` integer,
	`note` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`reminders` text NOT NULL,
	`channels` text NOT NULL,
	`guests` text NOT NULL,
	`posts` text NOT NULL,
	`reminders_sent` text NOT NULL,
	`created_at` text NOT NULL
);
