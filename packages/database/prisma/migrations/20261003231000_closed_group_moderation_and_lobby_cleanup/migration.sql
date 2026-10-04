-- Forward-only social lifecycle corrections; keep cascade-safe qualification.
CREATE OR REPLACE FUNCTION social_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
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
        -- Unpaid lobby participants no longer block start after they leave,
        -- are removed or lose active membership. Paid entries remain protected
        -- by the check above; never debit/refund money in this trigger.
        UPDATE public.group_pvp_entries e SET state='WITHDRAWN'
          FROM public.group_pvp_rounds r
          WHERE r.id=e.round_id AND r.group_id=OLD."groupId" AND e.user_id=OLD."userId"
            AND r.state='OPEN' AND e.state='JOINED' AND e.debit_id IS NULL
            AND (TG_OP='DELETE' OR NEW.status<>'ACTIVE' OR NEW."groupId"<>OLD."groupId" OR NEW."userId"<>OLD."userId");
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
  IF g.status<>'ACTIVE' OR g."expiresAt"<=clock_timestamp() THEN
    -- Preserve history while allowing an authorized moderator to hide abuse.
    -- No content/identity/receipt change, undeletion or reaction is permitted.
    IF TG_TABLE_NAME='messages' AND TG_OP='UPDATE' THEN
      IF NOT OLD."isDeleted" AND NEW."isDeleted"
        AND (to_jsonb(NEW)-'isDeleted'-'updatedAt') IS NOT DISTINCT FROM (to_jsonb(OLD)-'isDeleted'-'updatedAt')
        AND EXISTS(SELECT 1 FROM public.group_members m JOIN public.users u ON u.id=m."userId"
          WHERE m."groupId"=gid AND m."userId"=current_setting('playqube.moderator_id',true)
            AND m.status='ACTIVE' AND m.role IN ('OWNER','ADMIN') AND u.status='ACTIVE') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'GROUP_CLOSED';
  END IF;
  IF TG_OP='INSERT' AND uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.group_members WHERE "groupId"=gid AND "userId"=uid AND status='ACTIVE') THEN
    RAISE EXCEPTION 'GROUP_MEMBER_REQUIRED';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION social_group_guard() FROM PUBLIC;
