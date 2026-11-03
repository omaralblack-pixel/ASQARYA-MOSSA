CREATE TABLE `catalog` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`price` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`order_no` text NOT NULL,
	`driver` text NOT NULL,
	`branch` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`created` text NOT NULL,
	`manager` text,
	`signature` text,
	`decided` text,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_no_unique` ON `orders` (`order_no`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
