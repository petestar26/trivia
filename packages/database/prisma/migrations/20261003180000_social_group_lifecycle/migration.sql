-- Expiry closes the social room, never deletes financial or chat history.
ALTER TABLE groups ADD COLUMN "expiresAt" timestamptz(3);
UPDATE groups SET "expiresAt" = ("createdAt" AT TIME ZONE 'UTC') + interval '24 hours';
ALTER TABLE groups ALTER COLUMN "expiresAt" SET DEFAULT (clock_timestamp() + interval '24 hours');
ALTER TABLE groups ALTER COLUMN "expiresAt" SET NOT NULL;
CREATE INDEX groups_expiry ON groups("expiresAt") WHERE status = 'ACTIVE';
ALTER TABLE group_members ADD COLUMN "archivedAt" timestamp(3);
ALTER TABLE messages ADD COLUMN "clientRequestId" text;
CREATE UNIQUE INDEX messages_client_request ON messages("groupId","userId","clientRequestId");

ALTER TABLE group_pvp_rounds DROP CONSTRAINT group_pvp_rounds_game_check;
ALTER TABLE group_pvp_rounds DROP CONSTRAINT group_pvp_rounds_rules_id_check;
ALTER TABLE group_pvp_rounds ADD CHECK (
  (game IN ('spin_win','turbo_keno') AND rules_id='group-pvp-points-v1') OR
  (game='dice' AND rules_id='group-pvp-dice-v1'));

CREATE FUNCTION social_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE gid text; uid text; g record;
BEGIN
  IF TG_TABLE_NAME='groups' THEN
    IF NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN RAISE EXCEPTION 'GROUP_DEADLINE_IMMUTABLE'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='group_members' THEN
    IF TG_OP IN ('UPDATE','DELETE') THEN
      IF TG_OP='DELETE' OR NEW.status IS DISTINCT FROM OLD.status OR NEW."groupId" IS DISTINCT FROM OLD."groupId" OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN
        IF EXISTS(SELECT 1 FROM public.group_pvp_entries e JOIN public.group_pvp_rounds r ON r.id=e.round_id
          WHERE r.group_id=OLD."groupId" AND e.user_id=OLD."userId" AND e.state='READY' AND r.state IN ('OPEN','COUNTDOWN','DRAWN')) THEN
          RAISE EXCEPTION 'PVP_MEMBER_PROTECTED';
        END IF;
      END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' THEN
      IF NEW.status=OLD.status AND NEW."groupId"=OLD."groupId" AND NEW."userId"=OLD."userId" THEN RETURN NEW; END IF;
    END IF;
    IF NEW.status<>'ACTIVE' THEN RETURN NEW; END IF;
    gid:=NEW."groupId";
  ELSIF TG_TABLE_NAME='messages' THEN
    gid:=NEW."groupId"; uid:=NEW."userId";
  ELSIF TG_TABLE_NAME='message_reactions' THEN
    SELECT "groupId" INTO gid FROM public.messages WHERE id=COALESCE(NEW."messageId",OLD."messageId");
    uid:=COALESCE(NEW."userId",OLD."userId");
  END IF;
  -- Callers acquire group before membership/message locks. This read is a
  -- deadline backstop, not a second lock hierarchy inside a row trigger.
  SELECT status,"expiresAt" INTO g FROM public.groups WHERE id=gid;
  IF g.status<>'ACTIVE' OR g."expiresAt"<=clock_timestamp() THEN RAISE EXCEPTION 'GROUP_CLOSED'; END IF;
  IF TG_OP='INSERT' AND uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.group_members WHERE "groupId"=gid AND "userId"=uid AND status='ACTIVE') THEN
    RAISE EXCEPTION 'GROUP_MEMBER_REQUIRED';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_deadline_guard BEFORE UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION social_group_guard();
CREATE TRIGGER group_member_play_guard BEFORE INSERT OR UPDATE OR DELETE ON group_members FOR EACH ROW EXECUTE FUNCTION social_group_guard();
CREATE TRIGGER group_message_expiry_guard BEFORE INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION social_group_guard();
CREATE TRIGGER group_reaction_expiry_guard BEFORE INSERT OR UPDATE OR DELETE ON message_reactions FOR EACH ROW EXECUTE FUNCTION social_group_guard();
REVOKE ALL ON FUNCTION social_group_guard() FROM PUBLIC;
