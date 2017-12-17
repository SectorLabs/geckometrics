
CREATE TABLE metrics (
 id serial PRIMARY KEY,
 type VARCHAR (10), 
 date TIMESTAMP NOT NULL, 
 source VARCHAR (50) NOT NULL, 
 status NUMERIC, 
 service NUMERIC, 
 memory NUMERIC, 
 memoryquota NUMERIC, 
 load NUMERIC
);
