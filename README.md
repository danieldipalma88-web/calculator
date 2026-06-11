# Calculator

Vercel-hosted installer quote calculator with Supabase login.

## Environment variables

Add these in Vercel project settings:

```text
NEXT_PUBLIC_SUPABASE_URL=https://oslczpfasvsjthdbqeob.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_sw1gVqjqbdwRfu7E1XZtkA_zZKH9PIz
```

## Supabase setup

Run the SQL in `supabase/schema.sql` in the Supabase SQL editor.

Then add approved users to `public.approved_users`.

## Calculator source

`index.html` remains the calculator app. The Next.js routes wrap it with login protection.
