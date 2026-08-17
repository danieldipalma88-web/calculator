-- Verified from Electric Future "Weekly Pricing Update" emails in the
-- connected Green Energy Climate Control mailbox. Each row preserves the
-- original email timestamp and its Monday effective week.

insert into public.platform_certificate_value_history (
  effective_week,
  observed_at,
  esc_spot_price,
  prc_spot_price,
  source,
  observed_by_email
)
select
  date_trunc('week', timezone('Australia/Sydney', observation.observed_at))::date,
  observation.observed_at,
  observation.esc_spot_price,
  observation.prc_spot_price,
  'Electric Future weekly email',
  null
from (values
  ('2026-05-27 08:33:36+10'::timestamptz, 27.50::numeric, 3.00::numeric),
  ('2026-06-01 12:06:42+10'::timestamptz, 28.70::numeric, 3.00::numeric),
  ('2026-06-09 16:07:30+10'::timestamptz, 29.50::numeric, 3.10::numeric),
  ('2026-06-15 15:55:57+10'::timestamptz, 30.00::numeric, 3.30::numeric),
  ('2026-06-22 15:56:22+10'::timestamptz, 29.50::numeric, 3.30::numeric),
  ('2026-06-29 16:47:36+10'::timestamptz, 29.00::numeric, 3.35::numeric),
  ('2026-07-06 16:33:08+10'::timestamptz, 29.00::numeric, 3.00::numeric),
  ('2026-07-14 11:55:00+10'::timestamptz, 29.00::numeric, 3.00::numeric),
  ('2026-07-20 10:34:32+10'::timestamptz, 28.25::numeric, 3.00::numeric),
  ('2026-07-27 18:02:35+10'::timestamptz, 28.50::numeric, 2.90::numeric),
  ('2026-08-03 17:06:22+10'::timestamptz, 28.70::numeric, 2.60::numeric),
  ('2026-08-10 17:26:19+10'::timestamptz, 29.30::numeric, 2.65::numeric)
) as observation(observed_at, esc_spot_price, prc_spot_price)
on conflict (effective_week, esc_spot_price, prc_spot_price, source) do nothing;
