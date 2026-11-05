CREATE TABLE support_tickets (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE, request_id TEXT NOT NULL,
 subject TEXT NOT NULL CHECK(char_length(subject) BETWEEN 3 AND 120),
 category TEXT NOT NULL CHECK(category IN ('GENERAL','ACCOUNT','PAYMENTS','GAME')),
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
 last_sender TEXT NOT NULL DEFAULT 'USER' CHECK(last_sender IN ('USER','ADMIN')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,request_id)
);
CREATE INDEX support_tickets_owner_updated ON support_tickets(user_id,updated_at DESC,id);
CREATE INDEX support_tickets_status_updated ON support_tickets(status,updated_at DESC,id);
CREATE TABLE support_messages (
 id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE RESTRICT ON UPDATE CASCADE, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 staff BOOLEAN NOT NULL, body TEXT NOT NULL CHECK(char_length(body) BETWEEN 1 AND 4000), request_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(ticket_id,sender_id,request_id)
);
CREATE INDEX support_messages_thread_created ON support_messages(ticket_id,created_at,id);
-- Support records are separate from every balance, bet and ledger table.
