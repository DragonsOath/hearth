CREATE TABLE `resource_hourly` (
	`subject` text NOT NULL,
	`hour` text NOT NULL,
	`samples` integer DEFAULT 0 NOT NULL,
	`cpu_sum` real DEFAULT 0 NOT NULL,
	`cpu_max` real DEFAULT 0 NOT NULL,
	`mem_sum_mb` real DEFAULT 0 NOT NULL,
	`mem_max_mb` real DEFAULT 0 NOT NULL,
	`mem_limit_mb` real,
	`read_bytes` integer,
	`write_bytes` integer,
	`load_max` real,
	PRIMARY KEY(`subject`, `hour`)
);
