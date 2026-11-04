import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const catalog = sqliteTable('catalog', { code:text('code').primaryKey(), name:text('name').notNull(), unit:text('unit').notNull(), price:integer('price'), pack:integer('pack').notNull().default(1) });
export const settings = sqliteTable('settings',{key:text('key').primaryKey(),value:text('value').notNull()});
export const orders = sqliteTable('orders',{ id:text('id').primaryKey(), token:text('token').notNull(), orderNo:text('order_no').notNull().unique(), driver:text('driver').notNull(), branch:text('branch').notNull(), payload:text('payload').notNull(), status:text('status').notNull(), created:text('created').notNull(), manager:text('manager'), signature:text('signature'), decided:text('decided'), note:text('note') });

export const reconciliations=sqliteTable('reconciliations',{id:text('id').primaryKey(),transferNo:text('transfer_no').notNull().unique(),branch:text('branch').notNull(),driver:text('driver').notNull(),docDate:text('doc_date').notNull(),payload:text('payload').notNull(),status:text('status').notNull(),created:text('created').notNull(),updated:text('updated').notNull(),version:integer('version').notNull().default(1),revisionToken:text('revision_token').notNull()});
export const transferKeys=sqliteTable('transfer_keys',{key:text('key').primaryKey(),groupId:text('group_id').notNull()});
export const invoiceKeys=sqliteTable('invoice_keys',{key:text('key').primaryKey(),groupId:text('group_id').notNull()});
