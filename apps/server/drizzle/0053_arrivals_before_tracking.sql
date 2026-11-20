-- Recently Added before v0.25 counted files found by a pass that followed one which stopped short
-- (or a folder newly in scope) as new arrivals. Rows from then (no arrival window recorded) whose
-- file is more than two days older than when Hearth first saw it were there all along: they are
-- dated by their file, labelled "before Hearth was watching".
UPDATE `file_index` SET `basis` = 'timestamp', `first_seen_at` = `modified_at`
WHERE `basis` = 'observed' AND `seen_after` IS NULL AND `moved_from` IS NULL
  AND julianday(`first_seen_at`) - julianday(`modified_at`) > 2;
