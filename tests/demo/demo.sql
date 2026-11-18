-- Demo dataset for screenshots and benchmarks: a fictional SaaS company.
-- All names and values are generated; nothing here is real.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE plan_tier AS ENUM ('free', 'starter', 'growth', 'enterprise');

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  domain text NOT NULL UNIQUE,
  plan plan_tier NOT NULL,
  seats int NOT NULL,
  country char(2) NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  role text NOT NULL,
  last_seen_at timestamptz,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

CREATE TABLE invoices (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  amount numeric(12, 2) NOT NULL,
  status text NOT NULL,
  issued_at timestamptz NOT NULL,
  paid_at timestamptz
);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  name text NOT NULL,
  properties jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION pick(arr text[], i bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT arr[1 + (i % array_length(arr, 1))] $$;

INSERT INTO companies (name, domain, plan, seats, country, created_at)
SELECT pick(ARRAY['Acme','Globex','Initech','Umbrella','Hooli','Vandelay','Stark','Wayne','Tyrell','Cyberdyne','Soylent','Wonka','Aperture','Massive','Pied Piper','Prestige','Monarch','Oceanic','Gringotts','Nakatomi'], g)
       || ' ' || pick(ARRAY['Labs','Systems','Group','Partners','Analytics','Health','Robotics','Studios','Logistics','Capital'], g / 20) || ' ' || g,
       'co' || g || '.example.com',
       (ARRAY['free','starter','growth','enterprise'])[1 + (g * 7 % 10 + g % 3) % 4]::plan_tier,
       5 + (g * 37 % 495),
       pick(ARRAY['US','GB','DE','FR','CA','AU','JP','BR','IN','NL','SE','ES'], g * 3),
       timestamptz '2022-01-01' + (g * interval '23 minutes')
FROM generate_series(1::bigint, 20000) g;

CREATE TEMP TABLE company_ix AS
SELECT (row_number() OVER (ORDER BY created_at) - 1)::int AS i, id, domain, created_at FROM companies;
CREATE INDEX ON company_ix(i);

INSERT INTO users (company_id, email, full_name, role, last_seen_at, settings, created_at)
SELECT c.id,
       lower(pick(ARRAY['ava','liam','mia','noah','zoe','leo','ivy','eli','aria','max','nora','owen','ruby','theo','luna','jack'], g)) || '.' || g || '@' || c.domain,
       pick(ARRAY['Ava','Liam','Mia','Noah','Zoe','Leo','Ivy','Eli','Aria','Max','Nora','Owen','Ruby','Theo','Luna','Jack'], g) || ' '
         || pick(ARRAY['Chen','Patel','Garcia','Kim','Nguyen','Smith','Müller','Rossi','Silva','Tanaka','Okafor','Johansson','Dubois','Novak'], g / 16),
       pick(ARRAY['admin','member','member','member','viewer','billing'], g),
       CASE WHEN g % 9 = 0 THEN NULL ELSE timestamptz '2026-11-15' - (g % 2000) * interval '37 minutes' END,
       jsonb_build_object('theme', pick(ARRAY['dark','light','system'], g), 'digest', g % 2 = 0, 'locale', pick(ARRAY['en-US','en-GB','de-DE','fr-FR','ja-JP'], g)),
       c.created_at + (g % 400) * interval '1 day'
FROM generate_series(1::bigint, 400000) g
JOIN company_ix c ON c.i = g % 20000;

INSERT INTO invoices (company_id, amount, status, issued_at, paid_at)
SELECT c.id,
       round((49 + (g * 7919 % 9000) + (g % 100) / 100.0)::numeric, 2),
       pick(ARRAY['paid','paid','paid','paid','open','overdue','void'], g),
       timestamptz '2023-01-01' + (g * interval '157 seconds'),
       CASE WHEN g % 7 < 4 THEN timestamptz '2023-01-01' + (g * interval '157 seconds') + (g % 30) * interval '1 day' END
FROM generate_series(1::bigint, 1000000) g
JOIN company_ix c ON c.i = g % 20000;

INSERT INTO events (user_id, name, properties, occurred_at)
SELECT 1 + (g * 2654435761 % 400000),
       pick(ARRAY['page_view','page_view','page_view','click','search','export','invite_sent','report_run','login','api_call'], g),
       jsonb_build_object('path', '/' || pick(ARRAY['dashboard','reports','settings','billing','team','search'], g / 10), 'ms', g % 1500),
       timestamptz '2025-01-01' + (g * interval '6 seconds')
FROM generate_series(1::bigint, 5000000) g;

CREATE INDEX users_company_idx ON users(company_id);
CREATE INDEX invoices_company_idx ON invoices(company_id);
CREATE INDEX events_user_idx ON events(user_id);
CREATE INDEX events_occurred_idx ON events(occurred_at);

CREATE VIEW monthly_revenue AS
SELECT date_trunc('month', issued_at)::date AS month, plan, sum(amount) AS revenue, count(*) AS invoices
FROM invoices JOIN companies ON companies.id = invoices.company_id
WHERE status = 'paid'
GROUP BY 1, 2;

ANALYZE;
