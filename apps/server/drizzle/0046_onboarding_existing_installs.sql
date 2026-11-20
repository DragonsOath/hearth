-- Installs already claimed when the first-run welcome arrived are marked as done, so an owner
-- who set Dragon Control up before it existed is never sent there.
INSERT OR IGNORE INTO `settings` (`key`, `value`)
SELECT 'onboarding_done_at', json_quote(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE EXISTS (SELECT 1 FROM `owner`);
