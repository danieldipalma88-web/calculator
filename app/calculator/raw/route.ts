import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { canManageUsers, canSeeCommissionDetails, canSeeProfitDetails, isOwnerEmail, ownerEmails } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

function safeScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

type CalculatorUserContext = {
  email: string;
  viewingEmail: string;
  role: string;
  businessId: string | null;
  businessName: string;
  commissionType: string;
  agencyCommissionRate: number;
  salespersonCommissionRate: number;
  canManageUsers: boolean;
  canSeeCommissionDetails: boolean;
  canSeeProfitDetails: boolean;
  canSeeOwnerDetails: boolean;
  canSeeSalespersonCommission: boolean;
};

type ApprovedUser = {
  email: string;
  role: string;
  business_id?: string | null;
  commission_type_override?: string | null;
  agency_commission_rate_override?: number | null;
  salesperson_commission_rate_override?: number | null;
};

type Business = {
  id: string;
  name: string;
  commission_type: string;
  agency_commission_rate: number;
  salesperson_commission_rate: number;
};

const CERTIFICATE_VALUE_STORAGE_KEYS = [
  "installerCertificateValuesV1",
  "CertificateValuesV1",
];

const ESS_SETTINGS_STORAGE_KEYS = [
  "installerEssSettingsV1",
  "EssSettingsV1",
];

const MANAGED_PRICE_STORAGE_KEYS = [
  "installerManagedPricesV1",
  "ManagedPricesV1",
];

const DEFAULT_CERTIFICATE_VALUES = {
  escRate: 24.39,
  prcRate: 2.85,
  source: "Electric Future",
  locked: true,
  updatedAt: "",
};

function stripSensitiveQuoteFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveQuoteFields);
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("commission") ||
      lowerKey.includes("profit") ||
      lowerKey === "margin" ||
      lowerKey === "cashprofit"
    ) {
      continue;
    }
    output[key] = stripSensitiveQuoteFields(item);
  }
  return output;
}

function sanitizeCalculatorData(
  data: Record<string, unknown>,
  userContext: CalculatorUserContext,
) {
  if (userContext.canSeeCommissionDetails && userContext.canSeeProfitDetails) return data;

  const sanitized: Record<string, unknown> = { ...data };
  [
    "installerCommissionSettingsV1",
    "CommissionSettingsV1",
    "installerMasterQuoteLogV1",
    "MasterQuoteLogV1",
    "installerSavedQuoteSetsV1",
    "SavedQuoteSetsV1",
  ].forEach((key) => {
    if (!(key in sanitized)) return;
    if (key.toLowerCase().includes("commission")) {
      delete sanitized[key];
      return;
    }
    try {
      const parsed = JSON.parse(String(sanitized[key] || "null"));
      sanitized[key] = JSON.stringify(stripSensitiveQuoteFields(parsed));
    } catch {
      delete sanitized[key];
    }
  });

  return sanitized;
}

function parseStoredObject(value: unknown) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeCertificateValues(value: unknown) {
  const parsed = parseStoredObject(value);
  if (!parsed) return null;
  const escRate = Number(parsed.escRate);
  const prcRate = Number(parsed.prcRate);
  if (!(escRate > 0) || !(prcRate > 0)) return null;

  return {
    escRate,
    prcRate,
    source: String(parsed.source || DEFAULT_CERTIFICATE_VALUES.source),
    locked: parsed.locked === undefined ? true : Boolean(parsed.locked),
    updatedAt: String(parsed.updatedAt || ""),
  };
}

function ownerCertificateValuesFromData(data: Record<string, unknown>) {
  for (const key of CERTIFICATE_VALUE_STORAGE_KEYS) {
    const values = normalizeCertificateValues(data[key]);
    if (values) return values;
  }

  for (const key of ESS_SETTINGS_STORAGE_KEYS) {
    const values = normalizeCertificateValues(data[key]);
    if (values) {
      return {
        ...values,
        source: DEFAULT_CERTIFICATE_VALUES.source,
        locked: true,
      };
    }
  }

  return null;
}

function globalCertificateValuesFromData(data: Record<string, unknown>) {
  const values = ownerCertificateValuesFromData(data) || DEFAULT_CERTIFICATE_VALUES;
  const serialized = JSON.stringify(values);
  return {
    installerCertificateValuesV1: serialized,
    CertificateValuesV1: serialized,
  };
}

function stripCertificateRatesFromEssSettings(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    delete parsed.escRate;
    delete parsed.prcRate;
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}

function stripAccountCertificateSettings(data: Record<string, unknown>) {
  const output = { ...data };
  for (const key of CERTIFICATE_VALUE_STORAGE_KEYS) {
    delete output[key];
  }
  for (const key of ESS_SETTINGS_STORAGE_KEYS) {
    if (key in output) {
      output[key] = stripCertificateRatesFromEssSettings(output[key]);
    }
  }
  for (const key of MANAGED_PRICE_STORAGE_KEYS) {
    if (key in output) {
      output[key] = stripManagedRebateOverrides(output[key]);
    }
  }
  return output;
}

function stripManagedRebateOverrides(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      delete (entry as Record<string, unknown>).rebate;
      delete (entry as Record<string, unknown>).rebateManual;
    }
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}

function injectCloudStorageSync(
  html: string,
  data: Record<string, unknown>,
  userContext: CalculatorUserContext,
) {
  const syncUrl =
    userContext.viewingEmail && userContext.viewingEmail !== userContext.email
      ? `/api/calculator-data?as=${encodeURIComponent(userContext.viewingEmail)}`
      : "/api/calculator-data";
  const sanitizedData = sanitizeCalculatorData(data, userContext);
  const bootstrap = `
<script>
(function(){
  var cloudData = ${safeScriptJson(sanitizedData)};
  var calculatorUser = ${safeScriptJson(userContext)};
  var calculatorSyncUrl = ${safeScriptJson(syncUrl)};
  var profileStorageKey = '__calculatorProfileEmail';
  var profileEmail = (calculatorUser && (calculatorUser.viewingEmail || calculatorUser.email)) || '';
  var syncing = false;
  var timer = null;
  var lastSnapshotJson = '';
  window.CALCULATOR_USER = calculatorUser;
  function isAppStorageKey(key){
    return !!key && key.indexOf('sb-') !== 0 && key !== profileStorageKey;
  }
  function snapshot(){
    var output = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (isAppStorageKey(key)) output[key] = localStorage.getItem(key);
      }
    } catch (e) {}
    return output;
  }
  function storedValueHasData(value){
    if (typeof value !== 'string' || value.trim() === '') return false;
    try {
      var parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (parsed && typeof parsed === 'object') return Object.keys(parsed).length > 0;
      return parsed !== null && parsed !== '';
    } catch(e) {
      return true;
    }
  }
  function snapshotHasData(data){
    return Object.keys(data || {}).some(function(key){
      return isAppStorageKey(key) && storedValueHasData(data[key]);
    });
  }
  function setCloudValue(key, value){
    if (!isAppStorageKey(key) || typeof value !== 'string') return;
    var localValue = localStorage.getItem(key);
    if (!storedValueHasData(value) && storedValueHasData(localValue)) return;
    localStorage.setItem(key, value);
  }
  function stripCertificateRatesFromStoredEssValue(value){
    if (typeof value !== 'string' || value.trim() === '') return value;
    try {
      var parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
      delete parsed.escRate;
      delete parsed.prcRate;
      return JSON.stringify(parsed);
    } catch(e) {
      return value;
    }
  }
  function stripLocalCertificateRates(){
    ['installerEssSettingsV1', 'greenEnergyEssSettingsV1'].forEach(function(key){
      try {
        var value = localStorage.getItem(key);
        if (value !== null) localStorage.setItem(key, stripCertificateRatesFromStoredEssValue(value));
      } catch(e) {}
    });
  }
  function stripManagedRebateOverridesFromStoredValue(value){
    if (typeof value !== 'string' || value.trim() === '') return value;
    try {
      var parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
      Object.keys(parsed).forEach(function(key){
        var entry = parsed[key];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        delete entry.rebate;
        delete entry.rebateManual;
      });
      return JSON.stringify(parsed);
    } catch(e) {
      return value;
    }
  }
  function stripLocalManagedRebateOverrides(){
    if (calculatorUser && calculatorUser.canSeeOwnerDetails) return;
    ['installerManagedPricesV1', 'greenEnergyManagedPricesV1'].forEach(function(key){
      try {
        var value = localStorage.getItem(key);
        if (value !== null) localStorage.setItem(key, stripManagedRebateOverridesFromStoredValue(value));
      } catch(e) {}
    });
  }
  function writeSnapshot(force){
    var data = snapshot();
    var nextJson = JSON.stringify(data);
    if (!force && nextJson === lastSnapshotJson) return;
    lastSnapshotJson = nextJson;
    fetch(calculatorSyncUrl, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({data: data})
    }).catch(function(){});
  }
  function scheduleSync(force){
    if (syncing) return;
    clearTimeout(timer);
    timer = setTimeout(function(){
      writeSnapshot(!!force);
    }, 700);
  }
  function clearAppStorage(){
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (isAppStorageKey(key)) keys.push(key);
      }
      keys.forEach(function(key){ localStorage.removeItem(key); });
    } catch (e) {}
  }
  function applyCommissionSettings(){
    if (!calculatorUser) return;
    try {
      if (calculatorUser.commissionType === 'none') {
        localStorage.setItem('installerCommissionSettingsV1', JSON.stringify({agencyRate:0,agencyLocked:true,salespersonRate:0,salespersonLocked:true}));
        return;
      }
      localStorage.setItem('installerCommissionSettingsV1', JSON.stringify({
        agencyRate: Number(calculatorUser.agencyCommissionRate || 0),
        agencyLocked: true,
        salespersonRate: Number(calculatorUser.salespersonCommissionRate || 0),
        salespersonLocked: true
      }));
    } catch(e) {}
  }
  function hideElement(id){
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  function showElement(id){
    var el = document.getElementById(id);
    if (el) el.style.display = '';
  }
  function hideProfitAndCommissionUi(){
    if (calculatorUser && calculatorUser.canSeeCommissionDetails && calculatorUser.canSeeProfitDetails) return;
    hideElement('commissionRatePanel');
    hideElement('commissionRow');
    hideElement('commissionGstRow');
    hideElement('commissionIncRow');
    if (!calculatorUser || !calculatorUser.canSeeSalespersonCommission) {
      hideElement('salespersonCommissionRow');
      hideElement('netProfitRow');
    } else {
      showElement('salespersonCommissionRow');
      showElement('netProfitRow');
    }
    var salespersonLabel = document.getElementById('salespersonCommissionLabel');
    if (salespersonLabel) salespersonLabel.textContent = 'Salesperson commission';
    hideElement('salespersonCommissionGstRow');
    hideElement('salespersonCommissionIncRow');
    hideElement('marginRow');
    hideElement('cashProfitRow');
    var toggle = document.getElementById('commissionModelOn');
    if (toggle) {
      toggle.checked = false;
      var toggleRow = toggle.closest ? toggle.closest('.toggleRow') : null;
      if (toggleRow) toggleRow.style.display = 'none';
    }
  }
  function applyRoleUi(){
    if (document.body) {
      document.body.classList.toggle('restrictedOwnerDetails', !(calculatorUser && calculatorUser.canSeeOwnerDetails));
    }
    if (calculatorUser && calculatorUser.canManageUsers) {
      var certButtonForAdmin = document.getElementById('certValuesActionBtn');
      if (certButtonForAdmin && !document.getElementById('adminUsersActionBtn')) {
        var usersButton = document.createElement('button');
        usersButton.id = 'adminUsersActionBtn';
        usersButton.type = 'button';
        usersButton.className = 'secondary';
        usersButton.textContent = 'Users';
        usersButton.onclick = function(){
          try { window.top.location.href = '/admin/users'; }
          catch(e) { window.location.href = '/admin/users'; }
        };
        certButtonForAdmin.parentNode.insertBefore(usersButton, certButtonForAdmin.nextSibling);
      }
    } else {
      var certButton = document.getElementById('certValuesActionBtn');
      if (certButton) certButton.style.display = 'none';
      var certDrawer = document.getElementById('certDrawer');
      if (certDrawer) certDrawer.style.display = 'none';
      window.openCertDrawer = function(){ return false; };
    }
    if (!calculatorUser || !calculatorUser.canSeeOwnerDetails) {
      var ownerCertButton = document.getElementById('certValuesActionBtn');
      if (ownerCertButton) ownerCertButton.style.display = 'none';
      var ownerCertDrawer = document.getElementById('certDrawer');
      if (ownerCertDrawer) ownerCertDrawer.style.display = 'none';
      window.openCertDrawer = function(){ return false; };
    }
    hideProfitAndCommissionUi();
  }
  function wrapPrivacyRenderers(){
    ['render','renderQuotes','downloadCsv','downloadTxt'].forEach(function(name){
      var original = window[name];
      if (typeof original !== 'function' || original.__privacyWrapped) return;
      var wrapped = function(){
        var result = original.apply(this, arguments);
        hideProfitAndCommissionUi();
        return result;
      };
      wrapped.__privacyWrapped = true;
      window[name] = wrapped;
    });
    hideProfitAndCommissionUi();
  }
  try {
    syncing = true;
    var existingProfile = localStorage.getItem(profileStorageKey) || '';
    if (existingProfile && profileEmail && existingProfile !== profileEmail) clearAppStorage();
    stripLocalCertificateRates();
    stripLocalManagedRebateOverrides();
    Object.keys(cloudData || {}).forEach(function(key){
      setCloudValue(key, cloudData[key]);
    });
    stripLocalCertificateRates();
    stripLocalManagedRebateOverrides();
    applyCommissionSettings();
    localStorage.setItem(profileStorageKey, profileEmail);
    var shouldBackfillCloud = !snapshotHasData(cloudData) && snapshotHasData(snapshot());
    lastSnapshotJson = JSON.stringify(snapshot());
  } catch (e) {
  } finally {
    syncing = false;
  }
  try {
    var originalSetItem = localStorage.setItem.bind(localStorage);
    var originalRemoveItem = localStorage.removeItem.bind(localStorage);
    var originalClear = localStorage.clear.bind(localStorage);
    localStorage.setItem = function(key, value){
      originalSetItem(key, value);
      scheduleSync();
    };
    localStorage.removeItem = function(key){
      originalRemoveItem(key);
      scheduleSync();
    };
    localStorage.clear = function(){
      originalClear();
      scheduleSync();
    };
    document.addEventListener('input', function(){ scheduleSync(); }, true);
    document.addEventListener('change', function(){ scheduleSync(); }, true);
    setInterval(function(){ writeSnapshot(false); }, 5000);
    window.addEventListener('beforeunload', function(){
      try {
        navigator.sendBeacon(calculatorSyncUrl, new Blob([JSON.stringify({data: snapshot()})], {type: 'application/json'}));
      } catch(e) {}
    });
    if (typeof shouldBackfillCloud !== 'undefined' && shouldBackfillCloud) {
      setTimeout(function(){ writeSnapshot(true); }, 1000);
    }
  } catch (e) {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ applyRoleUi(); wrapPrivacyRenderers(); });
  else { applyRoleUi(); wrapPrivacyRenderers(); }
})();
</script>`;

  return html.replace("<script>", `${bootstrap}\n<script>`);
}

async function getApprovedUser(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
) {
  const upgraded = await supabase
    .from("approved_users")
    .select(
      "email, role, business_id, commission_type_override, agency_commission_rate_override, salesperson_commission_rate_override",
    )
    .eq("email", email)
    .maybeSingle();

  if (!upgraded.error) return upgraded;

  return supabase.from("approved_users").select("email, role").eq("email", email).maybeSingle();
}

async function getBusiness(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  businessId?: string | null,
) {
  if (!businessId) return null;
  const { data } = await supabase
    .from("businesses")
    .select("id, name, commission_type, agency_commission_rate, salesperson_commission_rate")
    .eq("id", businessId)
    .maybeSingle();
  return (data || null) as Business | null;
}

async function getSavedCalculatorData(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  currentUserId: string,
  currentEmail: string,
  viewingEmail: string,
) {
  const byEmail = await supabase
    .from("user_calculator_data")
    .select("data")
    .eq("email", viewingEmail)
    .maybeSingle();

  if (byEmail.data?.data) return byEmail.data.data as Record<string, unknown>;

  if (viewingEmail === currentEmail) {
    const { data } = await supabase
      .from("user_calculator_data")
      .select("data")
      .eq("user_id", currentUserId)
      .maybeSingle();
    return (data?.data || {}) as Record<string, unknown>;
  }

  return {};
}

async function getOwnerCertificateValues(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
) {
  const ownerEmail = ownerEmails[0];
  if (!ownerEmail) return {};

  const { data } = await supabase
    .from("user_calculator_data")
    .select("data")
    .eq("email", ownerEmail)
    .maybeSingle();

  return globalCertificateValuesFromData((data?.data || {}) as Record<string, unknown>);
}

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.redirect("/");
  }

  const currentEmail = user.email.toLowerCase();
  const { searchParams } = new URL(request.url);
  const requestedEmail = String(searchParams.get("as") || "").trim().toLowerCase();
  const { data: approvedUser } = await getApprovedUser(supabase, currentEmail);

  if (!approvedUser) {
    return new NextResponse("Not approved", { status: 403 });
  }

  const approved = approvedUser as ApprovedUser;
  const canManage = canManageUsers(currentEmail, approved.role);
  const viewingEmail = canManage && requestedEmail ? requestedEmail : currentEmail;
  const { data: viewedApprovedUser } =
    viewingEmail === currentEmail
      ? { data: approved }
      : await getApprovedUser(supabase, viewingEmail);
  const viewedUser = (viewedApprovedUser || approved) as ApprovedUser;
  const business = await getBusiness(supabase, viewedUser.business_id);
  const commissionType =
    viewedUser.commission_type_override || business?.commission_type || "none";
  const agencyCommissionRate = Number(
    viewedUser.agency_commission_rate_override ?? business?.agency_commission_rate ?? 0,
  );
  const salespersonCommissionRate = Number(
    viewedUser.salesperson_commission_rate_override ?? business?.salesperson_commission_rate ?? 0,
  );
  const contextRole = String(viewedUser.role || "user");
  const savedData = await getSavedCalculatorData(supabase, user.id, currentEmail, viewingEmail);
  const accountScopedData = isOwnerEmail(viewingEmail)
    ? { ...savedData }
    : stripAccountCertificateSettings(savedData);
  const globalCertificateValues = await getOwnerCertificateValues(supabase);
  const effectiveSavedData = {
    ...accountScopedData,
    ...globalCertificateValues,
  };

  const calculatorPath = path.join(process.cwd(), "index.html");
  const html = injectCloudStorageSync(
    await readFile(calculatorPath, "utf8"),
    effectiveSavedData,
    {
      email: currentEmail,
      viewingEmail,
      role: contextRole,
      businessId: business?.id || null,
      businessName: business?.name || "",
      commissionType,
      agencyCommissionRate,
      salespersonCommissionRate,
      canManageUsers: canManage,
      canSeeCommissionDetails: canSeeCommissionDetails(contextRole),
      canSeeProfitDetails: canSeeProfitDetails(contextRole),
      canSeeOwnerDetails: isOwnerEmail(viewingEmail),
      canSeeSalespersonCommission: true,
    },
  );

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
