PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_vault_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`tier` text NOT NULL,
	`category` text,
	`username` text,
	`endpoint` text,
	`notes` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`verified_at` text,
	`service_id` text,
	`ciphertext` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text,
	`scope` text DEFAULT 'read' NOT NULL,
	`last_ok_at` text,
	`last_failure_at` text,
	`last_failure` text,
	`last_failure_kind` text,
	`source` text
);
--> statement-breakpoint
INSERT INTO `__new_vault_secrets`("id", "name", "kind", "tier", "category", "username", "endpoint", "notes", "tags", "verified_at", "service_id", "ciphertext", "created_at", "updated_at", "last_used_at", "scope", "last_ok_at", "last_failure_at", "last_failure", "last_failure_kind", "source") SELECT "id", "name", "kind", "tier", "category", "username", "endpoint", "notes", "tags", "verified_at", "service_id", "ciphertext", "created_at", "updated_at", "last_used_at", "scope", "last_ok_at", "last_failure_at", "last_failure", "last_failure_kind", "source" FROM `vault_secrets`;--> statement-breakpoint
DROP TABLE `vault_secrets`;--> statement-breakpoint
ALTER TABLE `__new_vault_secrets` RENAME TO `vault_secrets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;