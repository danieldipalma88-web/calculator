import { readFile } from "node:fs/promises";

const [adminPage, calculatorPage, rawRoute, dataRoute, addressRoute, authCallback, schema, migration, userActivityMigration, styles] =
  await Promise.all([
    readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/calculator/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/calculator/raw/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/calculator-data/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/google-address/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/user_access_lock_upgrade.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/user_activity_upgrade.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

const checks = [
  [adminPage.includes("<h2>Won Quotes</h2>"), "Won Quotes heading"],
  [adminPage.includes('"Clear All" : "Select All"'), "Select All label behavior"],
  [!adminPage.includes("Select visible"), "old Select visible label removed"],
  [adminPage.includes("var selectedEmails = activeSalespersonEmails();"), "salesperson-scoped payment filters"],
  [adminPage.includes("var summaryPayments = appliesToSummary ? activePayments : [];"), "unselected salesperson totals preserved"],
  [adminPage.includes("<BusinessMultiSelect businesses={businesses} selectedIds={[]} />"), "new users start without a business"],
  [adminPage.includes("user-card-collapsible"), "collapsible approved users"],
  [adminPage.includes("action={setApprovedUserLock}"), "approved-user lock action"],
  [adminPage.includes("admin_list_approved_user_activity"), "approved-user activity lookup"],
  [adminPage.includes("formatLastActive(approvedUser.last_active_at)"), "last-active user detail"],
  [styles.includes(".won-toolbar-controls"), "compact Won Quotes toolbar"],
  [styles.includes(".user-card-summary"), "compact approved-user summaries"],
  [calculatorPage.includes("if (approved.is_locked)"), "calculator page lock enforcement"],
  [rawRoute.includes("if (approved.is_locked)"), "raw calculator lock enforcement"],
  [dataRoute.match(/approvedUser\?\.is_locked/g)?.length >= 2, "calculator API read/write lock enforcement"],
  [addressRoute.includes("is_locked"), "address API lock enforcement"],
  [authCallback.includes("approval.data?.is_locked"), "login callback lock enforcement"],
  [schema.includes("admin_set_approved_user_lock"), "canonical lock RPC"],
  [migration.includes("add column if not exists is_locked"), "live lock migration"],
  [migration.includes("and not coalesce(is_locked, false)"), "locked admins lose admin access"],
  [userActivityMigration.includes("record_current_user_activity"), "current-user activity tracker"],
  [userActivityMigration.includes("admin_list_approved_user_activity"), "admin activity RPC"],
  [userActivityMigration.includes("auth.users"), "historical sign-in activity backfill"],
];

const failed = checks.filter(([passed]) => !passed);
if (failed.length) {
  for (const [, label] of failed) console.error(`Missing ${label}.`);
  process.exit(1);
}

console.log("admin workflow checks passed");
