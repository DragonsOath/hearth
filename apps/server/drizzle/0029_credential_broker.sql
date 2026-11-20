ALTER TABLE `vault_secrets` ADD `scope` text DEFAULT 'approved-changes' NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `last_ok_at` text;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `last_failure_at` text;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `last_failure` text;--> statement-breakpoint
ALTER TABLE `vault_secrets` ADD `source` text;