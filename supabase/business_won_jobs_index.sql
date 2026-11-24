-- Append after business_won_jobs_read.sql in the SAME atomic migration.
-- A normal index build locks only this NEW, empty private table before enablement.
-- No index/FK/trigger/ALTER/DROP is performed on existing quote storage.
create index if not exists business_won_jobs_directory_keys_idx
on business_won_private.source_directory using gin (source_keys);
