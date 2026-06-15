# Calculator

Vercel-hosted installer quote calculator with Supabase login.

## Environment variables

Add these in Vercel project settings:

```text
NEXT_PUBLIC_SUPABASE_URL=https://oslczpfasvsjthdbqeob.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_sw1gVqjqbdwRfu7E1XZtkA_zZKH9PIz
```

## Supabase setup

Run the SQL in `supabase/schema.sql` in the Supabase SQL editor after each schema change.

The schema creates the default `Green Energy Climate Control` business, upgrades user roles,
and keeps `danieldipalma88@gmail.com` as the platform admin.

Platform admin users can manage businesses, approved users, roles, and commission settings
from `/admin/users` after the SQL policies have been run.

## Calculator source

`index.html` remains the calculator app. The Next.js routes wrap it with login protection.
