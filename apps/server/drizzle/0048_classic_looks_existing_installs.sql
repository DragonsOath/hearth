-- Ember's flame became the AI's default picture with the Hearth rebrand. Installs already
-- claimed keep the pictures they had (the dragon emblem, or each voice's own character), so
-- nobody's AI changes on update. New installs start with the flame.
INSERT OR IGNORE INTO `settings` (`key`, `value`)
SELECT 'ai_look_style', json_quote('classic')
WHERE EXISTS (SELECT 1 FROM `owner`);
