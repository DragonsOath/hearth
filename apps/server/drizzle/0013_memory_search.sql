-- One full-text index over everything the companion can recall: memory
-- entries, saved transcripts, and conversations in the app or with Belle.
-- Triggers keep it in step with the tables, so no code path can forget.
-- source: entry | transcript | conversation; ref: entry id, or "<parent id>:<seq>".
CREATE VIRTUAL TABLE `memory_search` USING fts5(source UNINDEXED, ref UNINDEXED, title, body, tokenize = 'porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `memory_entries_search_insert` AFTER INSERT ON `memory_entries` WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO memory_search(source, ref, title, body) VALUES ('entry', new.id, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entries_search_update` AFTER UPDATE ON `memory_entries` BEGIN
  DELETE FROM memory_search WHERE source = 'entry' AND ref = old.id;
  INSERT INTO memory_search(source, ref, title, body) SELECT 'entry', new.id, new.title, new.body WHERE new.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entries_search_delete` AFTER DELETE ON `memory_entries` BEGIN
  DELETE FROM memory_search WHERE source = 'entry' AND ref = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_transcript_messages_search_insert` AFTER INSERT ON `memory_transcript_messages` BEGIN
  INSERT INTO memory_search(source, ref, title, body) VALUES ('transcript', new.transcript_id || ':' || new.seq, '', new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_transcript_messages_search_delete` AFTER DELETE ON `memory_transcript_messages` BEGIN
  DELETE FROM memory_search WHERE source = 'transcript' AND ref = old.transcript_id || ':' || old.seq;
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_messages_search_insert` AFTER INSERT ON `conversation_messages` BEGIN
  INSERT INTO memory_search(source, ref, title, body) VALUES ('conversation', new.conversation_id || ':' || new.id, '', new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_messages_search_delete` AFTER DELETE ON `conversation_messages` BEGIN
  DELETE FROM memory_search WHERE source = 'conversation' AND ref = old.conversation_id || ':' || old.id;
END;
--> statement-breakpoint
-- Conversations that already exist become searchable too.
INSERT INTO memory_search(source, ref, title, body) SELECT 'conversation', conversation_id || ':' || id, '', text FROM conversation_messages;
