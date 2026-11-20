ALTER TABLE `vault_secrets` ADD `category` text;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `username` text;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `endpoint` text;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `verified_at` text;