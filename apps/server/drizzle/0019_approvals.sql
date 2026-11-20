ALTER TABLE `incidents` ADD `proposal_expires_at` text;--> statement-breakpoint
-- Proposals already waiting get a full window from the upgrade.
UPDATE `incidents` SET `proposal_expires_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day') WHERE `status` = 'awaiting-approval';
