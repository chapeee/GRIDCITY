-- A read-only monitoring user, as recommended in the docs.
CREATE USER 'monitor'@'%' IDENTIFIED BY 'test-monitor';
GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'monitor'@'%';
CREATE DATABASE shop;
CREATE TABLE shop.items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64));
INSERT INTO shop.items (name) VALUES ('a'), ('b'), ('c');
GRANT SELECT ON shop.* TO 'monitor'@'%';
