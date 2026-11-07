BEGIN;
CREATE TABLE public.payment_order_messages (
  id text PRIMARY KEY,
  "orderId" text REFERENCES public.agent_orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  "withdrawalId" text REFERENCES public.withdrawals(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  "authorId" text NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  "authorRole" text NOT NULL CHECK ("authorRole" IN ('member','agent','support')),
  body text NOT NULL CHECK (char_length(body) <= 4000),
  "idempotencyKey" text NOT NULL CHECK (char_length("idempotencyKey") BETWEEN 8 AND 128),
  "requestHash" text NOT NULL,
  "attachmentName" text,
  "attachmentMime" text,
  "attachmentBytes" bytea,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payment_order_message_parent CHECK (num_nonnulls("orderId","withdrawalId") = 1),
  CONSTRAINT payment_order_message_content CHECK (length(btrim(body)) > 0 OR "attachmentBytes" IS NOT NULL),
  CONSTRAINT payment_order_message_attachment CHECK (
    num_nonnulls("attachmentName","attachmentMime","attachmentBytes") = 0 OR
    (num_nonnulls("attachmentName","attachmentMime","attachmentBytes") = 3
      AND "attachmentMime" IN ('image/png','image/jpeg','image/webp')
      AND octet_length("attachmentBytes") BETWEEN 12 AND 2097152)
  ),
  UNIQUE ("authorId","idempotencyKey")
);
CREATE INDEX "payment_order_messages_orderId_createdAt_id_idx" ON public.payment_order_messages("orderId","createdAt",id);
CREATE INDEX "payment_order_messages_withdrawalId_createdAt_id_idx" ON public.payment_order_messages("withdrawalId","createdAt",id);
CREATE FUNCTION public.payment_order_messages_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Payment conversations and evidence are append-only'; END $$;
CREATE TRIGGER payment_order_messages_immutable BEFORE UPDATE OR DELETE ON public.payment_order_messages
FOR EACH ROW EXECUTE FUNCTION public.payment_order_messages_immutable();
REVOKE ALL ON public.payment_order_messages FROM PUBLIC;
ALTER FUNCTION public.ledger_apply_runtime_grants(text) RENAME TO ledger_apply_runtime_grants_pre_payment_rooms;
CREATE FUNCTION public.ledger_apply_runtime_grants(runtime_role text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM public.ledger_apply_runtime_grants_pre_payment_rooms(runtime_role);
  EXECUTE format('GRANT SELECT,INSERT ON public.payment_order_messages TO %I',runtime_role);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON public.payment_order_messages FROM %I',runtime_role);
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(text),public.ledger_apply_runtime_grants_pre_payment_rooms(text),public.payment_order_messages_immutable() FROM PUBLIC;
COMMIT;
