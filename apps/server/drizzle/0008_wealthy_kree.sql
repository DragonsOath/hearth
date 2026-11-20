CREATE TABLE `owner` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`recovery_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`password_changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text NOT NULL,
	`rp_id` text NOT NULL,
	`wrapped_private_key` text,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`verified_at` text NOT NULL,
	`user_agent` text
);
--> statement-breakpoint
CREATE TABLE `vault_keys` (
	`id` integer PRIMARY KEY NOT NULL,
	`automation_key_sealed` text NOT NULL,
	`key_guard` text NOT NULL,
	`protected_public_key` text NOT NULL,
	`private_by_password` text NOT NULL,
	`password_kdf_salt` text NOT NULL,
	`private_by_recovery` text NOT NULL,
	`recovery_kdf_salt` text NOT NULL,
	`prf_salt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`tier` text NOT NULL,
	`service_id` text,
	`ciphertext` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_used_at` text
);
