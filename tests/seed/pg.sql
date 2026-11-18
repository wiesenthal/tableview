CREATE TYPE plan_tier AS ENUM ('free','pro','team','enterprise');
CREATE TABLE customers (
  id serial PRIMARY KEY, email text NOT NULL UNIQUE, name text, plan plan_tier NOT NULL DEFAULT 'free',
  mrr numeric(10,2) NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, signup_at timestamptz NOT NULL,
  birthday date, ext_id uuid, prefs jsonb, tags text[], ip inet, score double precision
);
CREATE TABLE orders (
  id bigserial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), total numeric(12,2) NOT NULL,
  status text NOT NULL, created_at timestamp NOT NULL, note text
);
CREATE TABLE events_log (ts timestamptz NOT NULL, kind text, payload json);
CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE VIEW revenue_by_month AS SELECT date_trunc('month', created_at) AS month, sum(total) AS revenue, count(*) AS orders FROM orders GROUP BY 1;
INSERT INTO customers (email,name,plan,mrr,active,signup_at,birthday,ext_id,prefs,tags,ip,score)
SELECT 'user'||g||'@example.com', 'User '||g, (ARRAY['free','pro','team','enterprise'])[1+g%4]::plan_tier,
  (g%500)*1.25, g%7<>0, '2024-01-01'::timestamptz + (g||' hours')::interval,
  CASE WHEN g%5=0 THEN NULL ELSE '1980-01-01'::date + g%9000 END, md5(g::text)::uuid,
  jsonb_build_object('theme', CASE WHEN g%2=0 THEN 'dark' ELSE 'light' END, 'n', g), ARRAY['a'||g%3,'b'], ('10.0.'||g%250||'.1')::inet, sin(g)*100
FROM generate_series(1,5000) g;
INSERT INTO orders (customer_id,total,status,created_at,note)
SELECT 1+g%5000, (g%997)*3.17, (ARRAY['paid','refunded','pending'])[1+g%3], '2024-01-01'::timestamp + (g||' minutes')::interval*7, CASE WHEN g%10=0 THEN 'gift' END
FROM generate_series(1,200000) g;
INSERT INTO events_log SELECT now(), 'k'||g%5, json_build_object('g',g) FROM generate_series(1,100) g;
