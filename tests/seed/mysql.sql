SET SESSION cte_max_recursion_depth = 100000;
CREATE TABLE customers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(255),
  plan ENUM('free','pro','team','enterprise') NOT NULL DEFAULT 'free', mrr DECIMAL(10,2) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1, flags BIT(8), signup_at DATETIME(3) NOT NULL, birthday DATE,
  prefs JSON, big BIGINT UNSIGNED, score DOUBLE, avatar BLOB
);
CREATE TABLE orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, customer_id INT UNSIGNED NOT NULL, total DECIMAL(12,2) NOT NULL, status VARCHAR(20) NOT NULL, created_at TIMESTAMP NOT NULL, INDEX(customer_id));
CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status='paid';
INSERT INTO customers (email,name,plan,mrr,active,flags,signup_at,birthday,prefs,big,score,avatar)
WITH RECURSIVE seq(g) AS (SELECT 1 UNION ALL SELECT g+1 FROM seq WHERE g<3000)
SELECT CONCAT('user',g,'@example.com'), CONCAT('User ',g), ELT(1+g%4,'free','pro','team','enterprise'), (g%500)*1.25, g%7<>0, b'10100101',
  TIMESTAMPADD(HOUR,g,'2024-01-01'), IF(g%5=0,NULL,DATE_ADD('1980-01-01', INTERVAL g%9000 DAY)), JSON_OBJECT('n',g), 18446744073709551615 - g, SIN(g)*100, UNHEX('DEADBEEF')
FROM seq;
INSERT INTO orders (customer_id,total,status,created_at)
WITH RECURSIVE seq(g) AS (SELECT 1 UNION ALL SELECT g+1 FROM seq WHERE g<50000)
SELECT 1+g%3000, (g%997)*3.17, ELT(1+g%3,'paid','refunded','pending'), TIMESTAMPADD(MINUTE,g*7,'2024-01-01') FROM seq;
