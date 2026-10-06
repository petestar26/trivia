-- Dedicated monotonic sequence for AgentOrder.orderNumber ("AG-000123").
--
-- Root cause (Phase VIII-B/C): the previous allocator read
-- COUNT(*) FROM "agent_orders" as a proxy for "next number". Test cleanup
-- performs SCOPED deletes (by fixture user/agent id), never a table
-- truncate/reset, so the row count can legitimately DROP below a value it
-- held when an earlier, still-surviving order was numbered. The next
-- COUNT()+1 then collides with that surviving order's orderNumber and the
-- unique constraint throws — independent of any concurrency, reproducible
-- with zero concurrent callers, purely from deletion order.
--
-- A Postgres sequence is immune to this: nextval() is monotonic for the
-- lifetime of the sequence object regardless of how many rows are later
-- deleted, and nextval() is NOT transactional (a rolled-back transaction
-- does not return its consumed value), so two concurrent callers can never
-- observe the same value. This intentionally allows gaps in the numbering
-- (e.g. a transaction that later fails after allocating a number) but never
-- duplicates, which is the correct tradeoff for a human-facing display
-- number that this codebase's own prior comment already documented as
-- "not a security concern, only a display convenience."
CREATE SEQUENCE "agent_order_number_seq" START WITH 1 INCREMENT BY 1;

-- Seed the sequence past the highest orderNumber already issued, so that if
-- this migration runs against a database that already has AgentOrder rows,
-- the new allocator's first calls never re-collide with them. No-op (stays
-- at the sequence's own default start of 1) when the table is empty.
DO $$
DECLARE
  max_existing bigint;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING("orderNumber" FROM 'AG-(\d+)') AS bigint)), 0)
    INTO max_existing
    FROM "agent_orders";
  IF max_existing > 0 THEN
    PERFORM setval('agent_order_number_seq', max_existing);
  END IF;
END $$;