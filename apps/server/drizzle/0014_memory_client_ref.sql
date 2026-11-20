ALTER TABLE `memory_entries` ADD `client_ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `memory_entries_client_ref` ON `memory_entries` (`client_ref`);