CREATE TABLE `home_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`library_id` text NOT NULL,
	`library_name` text,
	`name` text NOT NULL,
	`definition` text NOT NULL,
	`published` text,
	`undo` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
