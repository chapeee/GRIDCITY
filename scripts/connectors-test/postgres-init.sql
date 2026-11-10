-- A read-only monitoring user, as recommended in the docs.
CREATE ROLE monitor LOGIN PASSWORD 'test-monitor';
GRANT pg_monitor TO monitor;
CREATE TABLE demo_items (id serial PRIMARY KEY, name text);
INSERT INTO demo_items (name) SELECT 'item ' || g FROM generate_series(1, 1000) g;
