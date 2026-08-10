import { readFile } from "node:fs/promises";

const [adminPage, businessMultiSelect, calculatorPage, rawRoute, dataRoute, addressRoute, authCallback, schema, migration, userActivityMigration, styles] =
  await Promise.all([
    readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/users/business-multi-select.tsx", import.meta.url), "utf8"),
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
  [adminPage.includes('"Select all " + visibleBoxes.length'), "filtered Select All label behavior"],
  [adminPage.includes('data-won-mobile-selection-dock'), "contextual mobile selection dock"],
  [adminPage.includes('data-won-search'), "Won Quotes search"],
  [adminPage.includes('data-won-sort'), "Won Quotes sort control"],
  [adminPage.includes('data-won-salesperson-option'), "multi-salesperson mobile filter"],
  [!adminPage.includes('data-won-salesperson-select'), "single-select salesperson filter removed"],
  [adminPage.includes('data-mobile-payment-filter'), "mobile payment filters"],
  [adminPage.includes('if (paymentSummary && selectedSalespeople.length'), "mobile payment filters remain available with salesperson filters"],
  [adminPage.includes('data-won-mobile-summary'), "mobile filtered totals summary"],
  [adminPage.includes('var hasSelection = selected.length > 0;'), "selection dock only appears after quote selection"],
  [adminPage.includes('rememberWonUiState(true)'), "Won Quotes update state persistence"],
  [!adminPage.includes("Select visible"), "old Select visible label removed"],
  [adminPage.includes("var selectedEmails = activeSalespersonEmails();"), "salesperson-scoped payment filters"],
  [adminPage.includes("var summaryPayments = appliesToSummary ? activePayments : [];"), "unselected salesperson totals preserved"],
  [adminPage.includes('nextParams.set("setupAction", "choose")'), "new-business user setup prompt redirect"],
  [adminPage.includes("action={assignApprovedUserToBusiness}"), "existing-user business assignment action"],
  [adminPage.includes("selectedIds={setupNewUserBusinessIds}"), "new business preselected for user creation"],
  [businessMultiSelect.includes("checked={selected.includes(business.id)}"), "business selection controlled checkbox"],
  [businessMultiSelect.includes("selectionLabel(businesses, selected)"), "business selection live summary"],
  [businessMultiSelect.includes("onChange={(event) => updateSelection"), "business selection state update"],
  [adminPage.includes("user-card-collapsible"), "collapsible approved users"],
  [adminPage.includes("action={setApprovedUserLock}"), "approved-user lock action"],
  [adminPage.includes("admin_list_approved_user_activity"), "approved-user activity lookup"],
  [adminPage.includes("formatLastActive(approvedUser.last_active_at)"), "last-active user detail"],
  [styles.includes(".won-toolbar-controls"), "compact Won Quotes toolbar"],
  [styles.includes(".won-filter-controls"), "Won Quotes filter controls"],
  [styles.includes(".won-mobile-selection-dock"), "sticky Won Quotes mobile dock"],
  [styles.includes("grid-template-columns: minmax(0, 1fr) 22px"), "compact mobile Won Quote card header"],
  [styles.includes(".won-mobile-filter-summary"), "mobile Won Quotes totals styling"],
  [styles.includes(".won-mobile-salesperson-options"), "mobile multi-salesperson picker styling"],
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
