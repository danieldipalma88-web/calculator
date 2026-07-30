import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  canManageUsers,
  canSeeAgencyProfit,
  canSeeCommissionDetails,
  canSeeProfitDetails,
  isOwnerEmail,
} from "../../../lib/admin";
import {
  CERTIFICATE_VALUES_STORAGE_KEYS,
  PLATFORM_CERTIFICATE_VALUES_ID,
  overlayPlatformCertificateValues,
  platformCertificateValuesFromRow,
  type PlatformCertificateValuesRow,
} from "../../../lib/certificate-values";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const calculatorHtmlPromise = readFile(
  path.join(process.cwd(), "index.html"),
  "utf8",
);

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
  currentUserCanManageUsers: boolean;
  canSeeCommissionDetails: boolean;
  canSeeProfitDetails: boolean;
  canSeeOwnerDetails: boolean;
  canSeeSalespersonCommission: boolean;
  canSeeAgencyProfit: boolean;
  isPreviewMode: boolean;
};

type ApprovedUser = {
  email: string;
  display_name?: string | null;
  role: string;
  business_id?: string | null;
  is_locked?: boolean;
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
  [...CERTIFICATE_VALUES_STORAGE_KEYS, ...WON_OPTION_ADMIN_STATE_STORAGE_KEYS].forEach((key) => {
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
  var googleMapsBrowserKey = ${safeScriptJson(String(process.env.GOOGLE_MAPS_BROWSER_KEY || ""))};
  var profileStorageKey = '__calculatorProfileEmail';
  var profileEmail = ((calculatorUser && (calculatorUser.viewingEmail || calculatorUser.email)) || '') + '|' + ((calculatorUser && calculatorUser.businessId) || '');
  var trustedManagedPriceKeys = {};
  var syncing = false;
  var timer = null;
  var lastSnapshotJson = '';
  var pendingSnapshot = null;
  var syncRequestInFlight = false;
  var inFlightSnapshotJson = '';
  var syncRetryTimer = null;
  var cloudSaveHideTimer = null;
  var cloudSaveWaiters = [];
  var saveRequestTimeoutMs = 12000;
  var certificateRefreshInFlight = false;
  var certificateRefreshIntervalMs = 60000;
  var certificateValueKeys = ['installerCertificateValuesV1', 'greenEnergyCertificateValuesV1', 'CertificateValuesV1'];
  window.CALCULATOR_USER = calculatorUser;
  window.CALCULATOR_GOOGLE_MAPS_BROWSER_KEY = googleMapsBrowserKey;
  window.__calculatorTrustedManagedPriceKeys = trustedManagedPriceKeys;
  function ensureCloudSaveStatus(){
    var existing = document.getElementById('cloudSaveStatus');
    if (existing) return existing;
    if (!document.body) return null;
    var status = document.createElement('div');
    status.id = 'cloudSaveStatus';
    status.className = 'cloudSaveStatus';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.dataset.tone = 'idle';
    status.textContent = '';
    status.setAttribute('aria-hidden', 'true');
    document.body.appendChild(status);
    return status;
  }
  function setCloudSaveStatus(message, tone){
    var status = ensureCloudSaveStatus();
    if (!status) return;
    clearTimeout(cloudSaveHideTimer);
    cloudSaveHideTimer = null;
    var nextTone = tone || 'idle';
    status.textContent = message || '';
    status.dataset.tone = nextTone;
    status.setAttribute('aria-hidden', nextTone === 'idle' ? 'true' : 'false');
    if (nextTone === 'saved') {
      cloudSaveHideTimer = setTimeout(function(){
        status.textContent = '';
        status.dataset.tone = 'idle';
        status.setAttribute('aria-hidden', 'true');
        cloudSaveHideTimer = null;
      }, 1800);
    }
  }
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
    if (localValue === value) return;
    localStorage.setItem(key, value);
    if (certificateValueKeys.indexOf(key) >= 0 && typeof window.applyAuthoritativeCertificateValues === 'function') {
      window.applyAuthoritativeCertificateValues(value);
    }
  }
  function authoritativeCertificateValue(data){
    if (!data || typeof data !== 'object') return null;
    for (var i = 0; i < certificateValueKeys.length; i++) {
      var key = certificateValueKeys[i];
      if (typeof data[key] === 'string' && data[key]) return {key:key,value:data[key]};
    }
    return null;
  }
  function refreshAuthoritativeCertificateValues(){
    if (certificateRefreshInFlight) return;
    certificateRefreshInFlight = true;
    fetch(calculatorSyncUrl, {
      method: 'GET',
      headers: {'Accept': 'application/json'},
      cache: 'no-store'
    }).then(function(response){
      if (!response.ok) throw new Error('Certificate value refresh failed');
      return response.json();
    }).then(function(result){
      var certificateValue = authoritativeCertificateValue(result && result.data);
      if (certificateValue) setCloudValue(certificateValue.key, certificateValue.value);
    }).catch(function(){
    }).finally(function(){
      certificateRefreshInFlight = false;
    });
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
  function settleCloudSaveWaiters(snapshotJson, error){
    var remaining = [];
    cloudSaveWaiters.forEach(function(waiter){
      if (waiter.json !== snapshotJson) {
        remaining.push(waiter);
        return;
      }
      clearTimeout(waiter.timeout);
      if (error) waiter.reject(error);
      else waiter.resolve({ok:true});
    });
    cloudSaveWaiters = remaining;
  }
  function waitForCloudSave(snapshotJson, timeoutMs){
    return new Promise(function(resolve, reject){
      var waiter = {
        json: snapshotJson,
        resolve: resolve,
        reject: reject,
        timeout: null
      };
      waiter.timeout = setTimeout(function(){
        cloudSaveWaiters = cloudSaveWaiters.filter(function(candidate){ return candidate !== waiter; });
        reject(new Error('The won quote could not be confirmed as saved. Check your connection and try again.'));
      }, Math.max(Number(timeoutMs) || 20000, saveRequestTimeoutMs + 1000));
      cloudSaveWaiters.push(waiter);
    });
  }
  function sendPendingSnapshot(){
    if (syncRequestInFlight || !pendingSnapshot) return;
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
    var request = pendingSnapshot;
    pendingSnapshot = null;
    syncRequestInFlight = true;
    inFlightSnapshotJson = request.json;
    setCloudSaveStatus('Saving...', 'saving');
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var requestTimeout = controller ? setTimeout(function(){ controller.abort(); }, saveRequestTimeoutMs) : null;
    var fetchOptions = {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({data: request.data})
    };
    if (controller) fetchOptions.signal = controller.signal;
    fetch(calculatorSyncUrl, fetchOptions).then(function(response){
      return response.json().catch(function(){ return {}; }).then(function(result){
        if (response.ok) return result;
        var error = new Error(result && result.error ? result.error : 'Calculator sync failed');
        error.status = response.status;
        error.permanent = response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429;
        throw error;
      });
    }).then(function(){
      lastSnapshotJson = request.json;
      if (pendingSnapshot && pendingSnapshot.json === lastSnapshotJson) pendingSnapshot = null;
      settleCloudSaveWaiters(request.json, null);
      setCloudSaveStatus(pendingSnapshot ? 'Saving...' : 'Saved', pendingSnapshot ? 'saving' : 'saved');
    }).catch(function(error){
      if (error && error.permanent) {
        settleCloudSaveWaiters(request.json, error);
        setCloudSaveStatus(pendingSnapshot ? 'Saving...' : 'Save failed', pendingSnapshot ? 'saving' : 'error');
      } else {
        if (!pendingSnapshot) pendingSnapshot = request;
        setCloudSaveStatus('Retrying...', 'retrying');
        clearTimeout(syncRetryTimer);
        syncRetryTimer = setTimeout(sendPendingSnapshot, 1800);
      }
    }).finally(function(){
      if (requestTimeout) clearTimeout(requestTimeout);
      syncRequestInFlight = false;
      inFlightSnapshotJson = '';
      if (pendingSnapshot && !syncRetryTimer) sendPendingSnapshot();
    });
  }
  function writeSnapshot(force){
    var data = snapshot();
    var nextJson = JSON.stringify(data);
    if (!force) {
      if (pendingSnapshot && nextJson === pendingSnapshot.json) return;
      if (syncRequestInFlight && !pendingSnapshot && nextJson === inFlightSnapshotJson) return;
      if (!syncRequestInFlight && !pendingSnapshot && nextJson === lastSnapshotJson) return;
    }
    pendingSnapshot = {data: data, json: nextJson};
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
    sendPendingSnapshot();
  }
  window.__calculatorFlushCloudSave = function(timeoutMs){
    var data = snapshot();
    var nextJson = JSON.stringify(data);
    if (!syncRequestInFlight && !pendingSnapshot && nextJson === lastSnapshotJson) {
      return Promise.resolve({ok:true});
    }
    var confirmation = waitForCloudSave(nextJson, timeoutMs);
    pendingSnapshot = {data:data, json:nextJson};
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
    sendPendingSnapshot();
    return confirmation;
  };
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
    if (!calculatorUser || !calculatorUser.canSeeAgencyProfit) {
      hideElement('agencyProfitAfterSalesRow');
      hideElement('multiAgencyProfitAfterSalesRow');
    }
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
    var multiCertValuesButton = document.getElementById('multiCertValuesActionBtn');
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
    if (multiCertValuesButton && !(calculatorUser && calculatorUser.canManageUsers)) {
      multiCertValuesButton.style.display = 'none';
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
    setInterval(refreshAuthoritativeCertificateValues, certificateRefreshIntervalMs);
    setTimeout(refreshAuthoritativeCertificateValues, 2000);
    window.addEventListener('focus', refreshAuthoritativeCertificateValues);
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'visible') refreshAuthoritativeCertificateValues();
    });
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setCloudSaveStatus('', 'idle'); });
  else setCloudSaveStatus('', 'idle');
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
      "email, display_name, role, business_id, is_locked, commission_type_override, agency_commission_rate_override, salesperson_commission_rate_override",
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

  const businessIdsPromise = businessIdsForEmail(
    supabase,
    String(viewedUser.email || "").toLowerCase(),
    viewedUser.business_id,
  );
  const requestedBusinessPromise = requestedBusinessId
    ? getBusiness(supabase, requestedBusinessId)
    : Promise.resolve(null);
  const [businessIds, requestedBusiness] = await Promise.all([
    businessIdsPromise,
    requestedBusinessPromise,
  ]);
  if (
    requestedBusinessId &&
    businessIds.includes(requestedBusinessId) &&
    requestedBusiness
  ) {
    return requestedBusiness;
  }
  const selectedBusinessId =
    businessIds[0] || viewedUser.business_id || null;

  return getBusiness(supabase, selectedBusinessId);
}

async function getSavedCalculatorData(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  currentUserId: string,
  currentEmail: string,
  viewingEmail: string,
  businessId?: string | null,
) {
  const byEmailPromise = supabase
    .from("user_calculator_data")
    .select("data")
    .eq("email", viewingEmail)
    .maybeSingle();
  const byUserPromise =
    viewingEmail === currentEmail
      ? supabase
      .from("user_calculator_data")
      .select("data")
      .eq("user_id", currentUserId)
      .maybeSingle()
      : Promise.resolve({ data: null, error: null });
  const businessPromise = businessId
    ? supabase
        .from("business_calculator_data")
        .select("data")
        .eq("business_id", businessId)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });
  const platformPromise = supabase
    .from("platform_certificate_values")
    .select("id, esc_spot_price, prc_spot_price, source, locked, updated_at")
    .eq("id", PLATFORM_CERTIFICATE_VALUES_ID)
    .maybeSingle();
  const [byEmail, byUser, businessResult, platformResult] = await Promise.all([
    byEmailPromise,
    byUserPromise,
    businessPromise,
    platformPromise,
  ]);

  let userData: Record<string, unknown> = (byEmail.data?.data || {}) as Record<string, unknown>;
  if (!byEmail.data?.data && byUser.data?.data) {
    userData = byUser.data.data as Record<string, unknown>;
  }

  let businessData: Record<string, unknown> = {};
  if (!businessResult.error) {
    businessData = (businessResult.data?.data || {}) as Record<string, unknown>;
  }

  const platformValues = platformResult.error
    ? null
    : platformCertificateValuesFromRow(
        platformResult.data as PlatformCertificateValuesRow | null,
      );
  businessData = overlayPlatformCertificateValues(businessData, platformValues);

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
  if (approved.is_locked) {
    return new NextResponse("Account locked", { status: 403 });
  }
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
  const useAdminVisibility = (currentUserIsOwner || approved.role === "admin") && !previewAsViewedUser;
  const currentUserCanSeeAgencyProfit = currentUserIsOwner || approved.role === "admin";
  const agencyProfitVisible = previewAsViewedUser
    ? canSeeAgencyProfit(contextRole)
    : currentUserCanSeeAgencyProfit || canSeeAgencyProfit(contextRole);
  const effectiveCanManageUsers = previewAsViewedUser
    ? canManageUsers(viewingEmail, contextRole)
    : canManage;

  const html = injectCloudStorageSync(
    await calculatorHtmlPromise,
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
      currentUserCanManageUsers: canManage,
      canSeeCommissionDetails: useAdminVisibility || canSeeCommissionDetails(contextRole),
      canSeeProfitDetails: useAdminVisibility || canSeeProfitDetails(contextRole),
      canSeeOwnerDetails: useAdminVisibility,
      canSeeSalespersonCommission: true,
      canSeeAgencyProfit: agencyProfitVisible,
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
