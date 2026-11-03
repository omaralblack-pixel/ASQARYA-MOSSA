PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_catalog` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`price` integer,
	`pack` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_catalog`("code", "name", "unit", "price", "pack") SELECT "code", "name", "unit", "price", "pack" FROM `catalog`;--> statement-breakpoint
DROP TABLE `catalog`;--> statement-breakpoint
ALTER TABLE `__new_catalog` RENAME TO `catalog`;--> statement-breakpoint
PRAGMA foreign_keys=ON;