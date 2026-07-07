import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { canManageUsers, canSeeCommissionDetails, canSeeProfitDetails, isOwnerEmail } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

function safeScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

type CalculatorUserContext = {
  email: string;
  displayName: string;
  viewingEmail: string;
  viewingDisplayName: string;
  role: string;
  businessId: string | null;
  businessName: string;
  businessOperatingState: string;
  rebateScheme: string;
  rebatesEnabled: boolean;
  commissionType: string;
  agencyCommissionRate: number;
  salespersonCommissionRate: number;
  canManageUsers: boolean;
  canSeeCommissionDetails: boolean;
  canSeeProfitDetails: boolean;
  canSeeOwnerDetails: boolean;
  canSeeSalespersonCommission: boolean;
  isPreviewMode: boolean;
};

type ApprovedUser = {
  email: string;
  display_name?: string | null;
  role: string;
  business_id?: string | null;
  commission_type_override?: string | null;
  agency_commission_rate_override?: number | null;
  salesperson_commission_rate_override?: number | null;
};

type Business = {
  id: string;
  name: string;
  operating_state?: string | null;
  commission_type: string;
  agency_commission_rate: number;
  salesperson_commission_rate: number;
};

function normalizeOperatingState(value: unknown) {
  const operatingState = String(value || "NSW").trim().toUpperCase();
  return ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"].includes(operatingState)
    ? operatingState
    : "NSW";
}

function rebateSchemeForState(operatingState: string) {
  if (operatingState === "NSW") return "nsw_ess";
  if (operatingState === "VIC") return "veu";
  return "none";
}

function rebatesEnabledForScheme(rebateScheme: string) {
  return rebateScheme === "nsw_ess";
}

function lastBusinessCookieName(email: string) {
  const slug = String(email || "account")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 90);
  return `calculatorLastBusinessV1_${slug || "account"}`;
}

function cookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return rawValue.join("=");
    }
  }
  return "";
}

const MANAGED_PRICE_STORAGE_KEYS = [
  "installerManagedPricesV1",
  "greenEnergyManagedPricesV1",
  "ManagedPricesV1",
];

const CERTIFICATE_VALUE_STORAGE_KEYS = [
  "installerCertificateValuesV1",
  "greenEnergyCertificateValuesV1",
  "CertificateValuesV1",
];

const WON_OPTION_ADMIN_STATE_STORAGE_KEYS = [
  "installerWonOptionAdminStateV1",
  "greenEnergyWonOptionAdminStateV1",
  "WonOptionAdminStateV1",
];

const OPTION_DEF_STORAGE_KEYS = [
  "installerQuoteOptionDefsV1",
  "greenEnergyQuoteOptionDefsV1",
  "QuoteOptionDefsV1",
];

const QUOTE_STORAGE_KEYS = [
  "installerMasterQuoteLogV1",
  "greenEnergyMasterQuoteLogV1",
  "MasterQuoteLogV1",
];

const SAVED_QUOTE_SET_STORAGE_KEYS = [
  "installerSavedQuoteSetsV1",
  "greenEnergySavedQuoteSetsV1",
  "SavedQuoteSetsV1",
];

const CURRENT_WON_SOURCE_ID = "current";

const BUSINESS_SHARED_STORAGE_KEYS = new Set([
  "installerManagedPricesV1",
  "greenEnergyManagedPricesV1",
  "ManagedPricesV1",
  "installerDefaultCostRulesV1",
  "greenEnergyDefaultCostRulesV1",
  "DefaultCostRulesV1",
]);

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

function stripAccountManagedRebateOverrides(data: Record<string, unknown>) {
  const output = { ...data };
  for (const key of MANAGED_PRICE_STORAGE_KEYS) {
    if (key in output) {
      output[key] = stripManagedRebateOverrides(output[key]);
    }
  }
  return output;
}

function trustedBusinessManagedPriceData(data: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const key of MANAGED_PRICE_STORAGE_KEYS) {
    if (key in data) output[key] = data[key];
  }
  return output;
}

function sharedBusinessDataFromUserData(data: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (BUSINESS_SHARED_STORAGE_KEYS.has(key)) output[key] = value;
  }
  return output;
}

function stripCertificateValueKeys(data: Record<string, unknown>) {
  const output = { ...data };
  [...CERTIFICATE_VALUE_STORAGE_KEYS, ...WON_OPTION_ADMIN_STATE_STORAGE_KEYS].forEach((key) => {
    delete output[key];
  });
  return output;
}

function parseStoredJson<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value) || (value && typeof value === "object")) return value as T;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function storedJsonKey(data: Record<string, unknown>, keys: string[]) {
  return keys.find((key) => key in data) || keys[0];
}

function serializeLikeStoredValue(original: unknown, value: unknown) {
  return typeof original === "string" || original === undefined ? JSON.stringify(value) : value;
}

function savedQuoteSetSourceId(set: Record<string, unknown>, index: number) {
  const id = String(set.id || "").trim();
  return id ? `saved:${id}` : `saved-index:${index}`;
}

function clearWonFields(record: Record<string, unknown>) {
  const next = { ...record };
  [
    "wonAt",
    "wonByEmail",
    "wonByName",
    "agencyPaidInAt",
    "agencyPaidInByEmail",
    "paidInAt",
    "paidInByEmail",
    "salespersonPaidOutAt",
    "salespersonPaidOutByEmail",
    "paidOutAt",
    "paidOutByEmail",
  ].forEach((key) => {
    delete next[key];
  });
  return next;
}

function wonAdminUnlockRecords(data: Record<string, unknown>) {
  const records: { sourceId: string; optionId: string; wonAt: string }[] = [];
  WON_OPTION_ADMIN_STATE_STORAGE_KEYS.forEach((storageKey) => {
    parseStoredJson<Record<string, unknown>[]>(data[storageKey], []).forEach((record) => {
      if (!record.unlockedAt) return;
      const optionId = String(record.optionId || "option_1").trim() || "option_1";
      const wonAt = String(record.wonAt || "").trim();
      if (!wonAt) return;
      records.push({
        sourceId: String(record.sourceId || CURRENT_WON_SOURCE_ID).trim() || CURRENT_WON_SOURCE_ID,
        optionId,
        wonAt,
      });
    });
  });
  return records;
}

function applyWonAdminUnlocks(data: Record<string, unknown>) {
  const unlockRecords = wonAdminUnlockRecords(data);
  if (!unlockRecords.length) return data;

  const nextData = { ...data };

  function shouldUnlock(sourceId: string, optionId: string, wonAt: unknown) {
    const normalizedWonAt = String(wonAt || "").trim();
    if (!normalizedWonAt) return false;
    return unlockRecords.some((record) => (
      record.sourceId === sourceId &&
      record.optionId === optionId &&
      record.wonAt === normalizedWonAt
    ));
  }

  function scrubCollections(
    sourceId: string,
    optionDefs: Record<string, unknown>[],
    quotes: Record<string, unknown>[],
  ) {
    let updated = false;
    const nextOptionDefs = optionDefs.map((option) => {
      const optionId = String(option.id || "option_1").trim() || "option_1";
      if (!shouldUnlock(sourceId, optionId, option.wonAt)) return option;
      updated = true;
      return clearWonFields(option);
    });
    const nextQuotes = quotes.map((quote) => {
      const optionId = String(quote.optionId || "option_1").trim() || "option_1";
      if (!shouldUnlock(sourceId, optionId, quote.wonAt)) return quote;
      updated = true;
      return clearWonFields(quote);
    });
    return updated ? { optionDefs: nextOptionDefs, quotes: nextQuotes } : null;
  }

  const optionDefsKey = storedJsonKey(nextData, OPTION_DEF_STORAGE_KEYS);
  const quotesKey = storedJsonKey(nextData, QUOTE_STORAGE_KEYS);
  const optionDefs = parseStoredJson<Record<string, unknown>[]>(nextData[optionDefsKey], []);
  const quotes = parseStoredJson<Record<string, unknown>[]>(nextData[quotesKey], []);
  const current = scrubCollections(CURRENT_WON_SOURCE_ID, optionDefs, quotes);
  if (current) {
    nextData[optionDefsKey] = serializeLikeStoredValue(nextData[optionDefsKey], current.optionDefs);
    nextData[quotesKey] = serializeLikeStoredValue(nextData[quotesKey], current.quotes);
  }

  const savedSetsKey = storedJsonKey(nextData, SAVED_QUOTE_SET_STORAGE_KEYS);
  const savedQuoteSets = parseStoredJson<Record<string, unknown>[]>(nextData[savedSetsKey], []);
  let savedSetsUpdated = false;
  const nextSavedQuoteSets = savedQuoteSets.map((savedQuoteSet, index) => {
    const savedOptionDefs = Array.isArray(savedQuoteSet.optionDefs)
      ? savedQuoteSet.optionDefs as Record<string, unknown>[]
      : [];
    const savedQuotes = Array.isArray(savedQuoteSet.quotes)
      ? savedQuoteSet.quotes as Record<string, unknown>[]
      : [];
    const scrubbed = scrubCollections(savedQuoteSetSourceId(savedQuoteSet, index), savedOptionDefs, savedQuotes);
    if (!scrubbed) return savedQuoteSet;
    savedSetsUpdated = true;
    return { ...savedQuoteSet, optionDefs: scrubbed.optionDefs, quotes: scrubbed.quotes };
  });
  if (savedSetsUpdated) {
    nextData[savedSetsKey] = serializeLikeStoredValue(nextData[savedSetsKey], nextSavedQuoteSets);
  }

  return nextData;
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
      ? `/api/calculator-data?as=${encodeURIComponent(userContext.viewingEmail)}${userContext.businessId ? `&businessId=${encodeURIComponent(userContext.businessId)}` : ""}`
      : `/api/calculator-data${userContext.businessId ? `?businessId=${encodeURIComponent(userContext.businessId)}` : ""}`;
  const sanitizedData = sanitizeCalculatorData(data, userContext);
  const bootstrap = `
<script>
(function(){
  var cloudData = ${safeScriptJson(sanitizedData)};
  var calculatorUser = ${safeScriptJson(userContext)};
  var calculatorSyncUrl = ${safeScriptJson(syncUrl)};
  var profileStorageKey = '__calculatorProfileEmail';
  var profileEmail = ((calculatorUser && (calculatorUser.viewingEmail || calculatorUser.email)) || '') + '|' + ((calculatorUser && calculatorUser.businessId) || '');
  var trustedManagedPriceKeys = {};
  var syncing = false;
  var timer = null;
  var lastSnapshotJson = '';
  window.CALCULATOR_USER = calculatorUser;
  window.__calculatorTrustedManagedPriceKeys = trustedManagedPriceKeys;
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
      if (trustedManagedPriceKeys[key]) return;
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
    var certValuesButton = document.getElementById('certValuesActionBtn');
    if (certValuesButton) {
      if (calculatorUser && calculatorUser.canManageUsers) {
        certValuesButton.textContent = 'Certificate Values';
        certValuesButton.onclick = function(){
          try { window.top.location.href = '/admin/users#certificate-values'; }
          catch(e) { window.location.href = '/admin/users#certificate-values'; }
        };
      } else {
        certValuesButton.style.display = 'none';
      }
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
      if (key === 'installerManagedPricesV1' || key === 'greenEnergyManagedPricesV1' || key === 'ManagedPricesV1') {
        trustedManagedPriceKeys[key] = true;
      }
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
      "email, display_name, role, business_id, commission_type_override, agency_commission_rate_override, salesperson_commission_rate_override",
    )
    .eq("email", email)
    .maybeSingle();

  if (!upgraded.error) return upgraded;

  return supabase.from("approved_users").select("email, role").eq("email", email).maybeSingle();
}

function accountDisplayName(user: ApprovedUser | null | undefined, fallbackEmail: string) {
  return String(user?.display_name || user?.email || fallbackEmail);
}

async function getBusiness(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  businessId?: string | null,
) {
  if (!businessId) return null;
  const upgraded = await supabase
    .from("businesses")
    .select("id, name, operating_state, commission_type, agency_commission_rate, salesperson_commission_rate")
    .eq("id", businessId)
    .maybeSingle();

  if (!upgraded.error) return (upgraded.data || null) as Business | null;

  const { data } = await supabase
    .from("businesses")
    .select("id, name, commission_type, agency_commission_rate, salesperson_commission_rate")
    .eq("id", businessId)
    .maybeSingle();
  return (data || null) as Business | null;
}

async function businessIdsForEmail(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
  fallbackBusinessId?: string | null,
) {
  const ids = new Set<string>();
  if (fallbackBusinessId) ids.add(fallbackBusinessId);

  const memberships = await supabase
    .from("approved_user_businesses")
    .select("business_id")
    .eq("email", email);

  if (!memberships.error) {
    (memberships.data || []).forEach((row: { business_id?: string | null }) => {
      if (row.business_id) ids.add(row.business_id);
    });
  }

  return [...ids];
}

async function resolveActiveBusiness(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  viewedUser: ApprovedUser,
  requestedBusinessId: string,
  allowAnyBusiness: boolean,
) {
  if (allowAnyBusiness && requestedBusinessId) {
    return getBusiness(supabase, requestedBusinessId);
  }

  const businessIds = await businessIdsForEmail(
    supabase,
    String(viewedUser.email || "").toLowerCase(),
    viewedUser.business_id,
  );
  const selectedBusinessId =
    requestedBusinessId && businessIds.includes(requestedBusinessId)
      ? requestedBusinessId
      : businessIds[0] || viewedUser.business_id || null;

  return getBusiness(supabase, selectedBusinessId);
}

async function getSavedCalculatorData(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  currentUserId: string,
  currentEmail: string,
  viewingEmail: string,
  businessId?: string | null,
) {
  const byEmail = await supabase
    .from("user_calculator_data")
    .select("data")
    .eq("email", viewingEmail)
    .maybeSingle();

  let userData: Record<string, unknown> = (byEmail.data?.data || {}) as Record<string, unknown>;

  if (viewingEmail === currentEmail) {
    const { data } = await supabase
      .from("user_calculator_data")
      .select("data")
      .eq("user_id", currentUserId)
      .maybeSingle();
    if (!byEmail.data?.data) userData = (data?.data || {}) as Record<string, unknown>;
  }

  let businessData: Record<string, unknown> = {};
  if (businessId) {
    const businessResult = await supabase
      .from("business_calculator_data")
      .select("data")
      .eq("business_id", businessId)
      .maybeSingle();

    if (!businessResult.error) {
      businessData = (businessResult.data?.data || {}) as Record<string, unknown>;
    }
  }

  const unlockedUserData = applyWonAdminUnlocks(userData);
  const cleanedUserData = stripCertificateValueKeys(unlockedUserData);
  const data = { ...cleanedUserData, ...sharedBusinessDataFromUserData(cleanedUserData), ...businessData };
  return { data, businessData };
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
  const requestedPreview = searchParams.get("preview") === "1";
  const requestedBusinessId = String(searchParams.get("businessId") || "").trim();
  const { data: approvedUser } = await getApprovedUser(supabase, currentEmail);

  if (!approvedUser) {
    return new NextResponse("Not approved", { status: 403 });
  }

  const approved = approvedUser as ApprovedUser;
  const canManage = canManageUsers(currentEmail, approved.role);
  const viewingEmail = canManage && requestedEmail ? requestedEmail : currentEmail;
  const previewAsViewedUser = canManage && requestedPreview && viewingEmail !== currentEmail;
  const rememberedBusinessId = String(cookieValue(request, lastBusinessCookieName(viewingEmail)) || "").trim();
  const effectiveRequestedBusinessId = requestedBusinessId || rememberedBusinessId;
  const { data: viewedApprovedUser } =
    viewingEmail === currentEmail
      ? { data: approved }
      : await getApprovedUser(supabase, viewingEmail);
  const viewedUser = (viewedApprovedUser || approved) as ApprovedUser;
  const currentUserIsOwner = isOwnerEmail(currentEmail);
  const business = await resolveActiveBusiness(
    supabase,
    viewedUser,
    effectiveRequestedBusinessId,
    currentUserIsOwner,
  );
  const businessOperatingState = normalizeOperatingState(business?.operating_state);
  const rebateScheme = rebateSchemeForState(businessOperatingState);
  const commissionType =
    viewedUser.commission_type_override || business?.commission_type || "none";
  const agencyCommissionRate = Number(
    viewedUser.agency_commission_rate_override ?? business?.agency_commission_rate ?? 0,
  );
  const salespersonCommissionRate = Number(
    viewedUser.salesperson_commission_rate_override ?? business?.salesperson_commission_rate ?? 0,
  );
  const contextRole = String(viewedUser.role || "user");
  const savedDataResult = await getSavedCalculatorData(
    supabase,
    user.id,
    currentEmail,
    viewingEmail,
    business?.id || null,
  );
  const savedData = savedDataResult.data;
  const effectiveSavedData = isOwnerEmail(viewingEmail)
    ? { ...savedData }
    : {
        ...stripAccountManagedRebateOverrides(savedData),
        ...trustedBusinessManagedPriceData(savedDataResult.businessData),
      };
  const useAdminVisibility = currentUserIsOwner && !previewAsViewedUser;
  const effectiveCanManageUsers = previewAsViewedUser
    ? canManageUsers(viewingEmail, contextRole)
    : canManage;

  const calculatorPath = path.join(process.cwd(), "index.html");
  const html = injectCloudStorageSync(
    await readFile(calculatorPath, "utf8"),
    effectiveSavedData,
    {
      email: currentEmail,
      displayName: accountDisplayName(approved as ApprovedUser, currentEmail),
      viewingEmail,
      viewingDisplayName: accountDisplayName(viewedUser, viewingEmail),
      role: contextRole,
      businessId: business?.id || null,
      businessName: business?.name || "",
      businessOperatingState,
      rebateScheme,
      rebatesEnabled: rebatesEnabledForScheme(rebateScheme),
      commissionType,
      agencyCommissionRate,
      salespersonCommissionRate,
      canManageUsers: effectiveCanManageUsers,
      canSeeCommissionDetails: useAdminVisibility || canSeeCommissionDetails(contextRole),
      canSeeProfitDetails: useAdminVisibility || canSeeProfitDetails(contextRole),
      canSeeOwnerDetails: useAdminVisibility,
      canSeeSalespersonCommission: true,
      isPreviewMode: previewAsViewedUser,
    },
  );

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
