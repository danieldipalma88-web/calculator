export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
export const publicSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL || "https://calculator.studioleads.com.au";

export function hasSupabaseConfig() {
  return Boolean(supabaseUrl && supabasePublishableKey);
}
