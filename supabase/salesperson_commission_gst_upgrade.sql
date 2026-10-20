-- Preserve existing GST treatment unless an admin explicitly changes the user.
alter table public.approved_users
  add column if not exists salesperson_gst_registered boolean not null default true;

notify pgrst, 'reload schema';
