import { readFile } from "node:fs/promises";
import { calculatorAddedProducts, readAddedModels } from "../../../lib/model-catalogue";
import path from "node:path";
import { NextResponse } from "next/server";
import { parseAadCataloguePriceDefaults } from "../../../lib/aad-catalogue-price-defaults";
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
import {
  DCCEEW_CONTRACT_RATE,
  DCCEEW_ELIGIBLE_POSTCODES,
  DCCEEW_ELIGIBLE_PRODUCT_KEYS,
} from "../../../lib/dcceew-contract-data";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { visibleCalculatorData } from "../../../lib/quote-data-visibility";
import { applyStoredQuoteAdminUnlocks } from "../../../lib/quote-family";
import { BUSINESS_CONFIGURATION_STORAGE_KEY, validateBusinessCalculatorConfiguration, validatedBusinessConfigurationData, withoutBusinessConfiguration } from "../../../lib/business-calculator-configuration";
import { calculatorReleaseVersion } from "../../../lib/calculator-release";
import { injectCalculatorUpdateNotice } from "../../../lib/calculator-update-notice";
import { calculatorTransferResponse } from "../../../lib/calculator-transfer-response";

const calculatorHtmlPromise = readFile(
  path.join(process.cwd(), "index.html"),
  "utf8",
);

const aadCataloguePrices = parseAadCataloguePriceDefaults(process.env.AAD_CATALOGUE_PRICE_DEFAULTS);

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
  salespersonGstRegistered: boolean;
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
  salesperson_gst_registered?: boolean;
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
  "installerBusinessConfigurationV1",
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
    if (lowerKey === "salespersoncommissioninc" && value && "wonAt" in value && value.wonAt) {
      output[key] = item;
      continue;
    }
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
  return visibleCalculatorData(data,
    userContext.canSeeCommissionDetails && userContext.canSeeProfitDetails,
    userContext.canSeeSalespersonCommission === true);
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
  data = applyStoredQuoteAdminUnlocks(data);
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
  let syncUrl =
    userContext.viewingEmail && userContext.viewingEmail !== userContext.email
      ? `/api/calculator-data?as=${encodeURIComponent(userContext.viewingEmail)}${userContext.businessId ? `&businessId=${encodeURIComponent(userContext.businessId)}` : ""}`
      : `/api/calculator-data${userContext.businessId ? `?businessId=${encodeURIComponent(userContext.businessId)}` : ""}`;
  if (userContext.isPreviewMode) syncUrl += `${syncUrl.includes("?") ? "&" : "?"}preview=1`;
  const sanitizedData = sanitizeCalculatorData(data, userContext);
  const loadedConfiguration = validateBusinessCalculatorConfiguration(sanitizedData[BUSINESS_CONFIGURATION_STORAGE_KEY], userContext.businessId);
  const bootstrap = `
<script>
(function(){
  var cloudData = ${safeScriptJson(sanitizedData)};
  var calculatorUser = ${safeScriptJson(userContext)};
  var businessConfigurationKey = ${safeScriptJson(BUSINESS_CONFIGURATION_STORAGE_KEY)};
  var loadedBusinessConfiguration = ${safeScriptJson(loadedConfiguration ? JSON.stringify(loadedConfiguration) : null)};
  var businessConfigurationRevision = ${safeScriptJson(loadedConfiguration?.revision ?? null)};
  Object.defineProperty(window, '__calculatorLoadedBusinessConfiguration', {value:loadedBusinessConfiguration});
  var calculatorSyncUrl = ${safeScriptJson(syncUrl)};
  var calculatorSettingsUrl = calculatorSyncUrl + (calculatorSyncUrl.indexOf('?') >= 0 ? '&' : '?') + 'mode=rebate-settings';
  var profileStorageKey = '__calculatorProfileEmail';
  var accountStorageKey = '__calculatorSignedInEmail';
  var profileEmail = (calculatorUser.viewingEmail || calculatorUser.email || '') + '|' + (calculatorUser.businessId || '');
  var expectedWorkspace = {accountEmail:calculatorUser.email, viewingEmail:calculatorUser.viewingEmail || calculatorUser.email, businessId:calculatorUser.businessId || null};
  var pendingStorageKey = '__calculatorPendingSaveV1:' + calculatorUser.email + '|' + profileEmail;
  var pendingRecovery = null;
  var recoveryRequired = false;
  var workspaceChanged = false;
  var recoveryStorageFailed = false;
  var refreshBlockedStorageKeys = Object.create(null);
  try {
    var storedRecovery = sessionStorage.getItem(pendingStorageKey);
    if (storedRecovery) {
      var parsedRecovery = JSON.parse(storedRecovery);
      if (parsedRecovery && parsedRecovery.version === 1 && parsedRecovery.profile === pendingStorageKey && parsedRecovery.envelope && (parsedRecovery.envelope.data || parsedRecovery.envelope.quoteArrange || parsedRecovery.envelope.quoteEdit || parsedRecovery.envelope.quoteCopy)) {
        pendingRecovery = parsedRecovery;
        recoveryRequired = true;
      }
    }
  } catch(e) { recoveryStorageFailed = true; }
  var trustedManagedPriceKeys = {};
  var syncing = false;
  var timer = null;
  var lastSnapshotJson = '';
  var pendingSnapshot = null;
  var syncRequestInFlight = false;
  var inFlightSnapshotJson = '';
  var syncRetryTimer = null;
  var syncFailures = 0;
  var syncRetryPaused = false;
  var syncRetryDelaysMs = [3000, 10000];
  var cloudSaveHideTimer = null;
  var cloudSaveWaiters = [];
  var quoteConflictError = null;
  var quoteArrangeAttempt = null;
  window.__calculatorQuoteConflict = null;
  var saveRequestTimeoutMs = 12000;
  var certificateRefreshInFlight = false;
  var certificateRefreshIntervalMs = 60000;
  var certificateRefreshTimeoutMs = 12000;
  var certificateValueKeys = ['installerCertificateValuesV1', 'greenEnergyCertificateValuesV1', 'CertificateValuesV1'];
  var lastActivityAttemptAt = null;
  function recordVisibleUserInteraction(event){
    if (!event.isTrusted || document.visibilityState !== 'visible') return;
    var now = performance.now();
    if (lastActivityAttemptAt !== null && now - lastActivityAttemptAt < 60000) return;
    lastActivityAttemptAt = now;
    try {
      fetch('/api/user-activity', {method: 'POST', credentials: 'same-origin', cache: 'no-store'}).catch(function(){});
    } catch(e) {}
  }
  ['pointerdown', 'keydown', 'input', 'change'].forEach(function(type){
    document.addEventListener(type, recordVisibleUserInteraction, {capture: true, passive: true});
  });
  window.DCCEEW_CONTRACT_DATA = ${safeScriptJson({
    rate: DCCEEW_CONTRACT_RATE,
    postcodes: DCCEEW_ELIGIBLE_POSTCODES,
    productKeys: DCCEEW_ELIGIBLE_PRODUCT_KEYS,
  })};
  window.CALCULATOR_USER = calculatorUser;
  window.validateBusinessCalculatorConfiguration = ${validateBusinessCalculatorConfiguration.toString()};
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
    document.body.insertBefore(status, document.body.firstChild);
    return status;
  }
  function setCloudSaveStatus(message, tone){
    window.__calculatorCloudSaveState = {message:message || '', tone:tone || 'idle'};
    window.dispatchEvent(new Event('calculator-cloud-save-status'));
    var status = ensureCloudSaveStatus();
    if (!status) return;
    clearTimeout(cloudSaveHideTimer);
    cloudSaveHideTimer = null;
    var nextTone = tone || 'idle';
    status.textContent = message || '';
    status.dataset.tone = nextTone;
    status.setAttribute('aria-hidden', nextTone === 'idle' ? 'true' : 'false');
    if (nextTone === 'error' && syncRetryPaused && !workspaceChanged && !recoveryRequired && !quoteConflictError && !quoteArrangeAttempt) {
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'secondary';
      retry.textContent = 'Retry save';
      retry.onclick = function(){ window.__calculatorFlushCloudSave(20000).catch(function(){}); };
      status.appendChild(retry);
    }
    if (nextTone === 'error' && pendingRecovery && !workspaceChanged && !recoveryRequired) {
      var download = document.createElement('button');
      download.type = 'button';
      download.className = 'secondary';
      download.textContent = 'Back up';
      download.title = 'Download pending changes before closing this tab';
      download.onclick = downloadPendingRecovery;
      status.appendChild(download);
    }
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
    return !!key && key.indexOf('sb-') !== 0 && key !== profileStorageKey && key !== accountStorageKey;
  }
  function saveEnvelope(request){
    return {data:request.data, businessConfigurationRevision:businessConfigurationRevision, equipmentPriceEdits:equipmentPriceEditsForSnapshot(request.data), expectedWorkspace:expectedWorkspace};
  }
  async function saveRequestBody(envelope, signal){
    var json = JSON.stringify(envelope);
    var plain = new Blob([json], {type:'application/json'});
    var body = json;
    var contentType = 'application/json';
    if (plain.size > 32000000) throw saveSizeError();
    if (plain.size > 262144 && typeof CompressionStream === 'function') {
      try {
        var compressed = plain.stream().pipeThrough(new CompressionStream('gzip'), signal ? {signal:signal} : {});
        body = await new Response(compressed).blob();
        contentType = 'application/vnd.rebate-portal.calculator-save+gzip';
      } catch(error) {
        if (signal && signal.aborted) throw error;
        if (plain.size > 4400000) throw saveSizeError();
      }
    }
    if (signal && signal.aborted) throw new Error('Save confirmation timed out.');
    if ((typeof body === 'string' ? plain.size : body.size) > 4400000) throw saveSizeError();
    if (!workspaceIsCurrent()) {
      var changed = new Error('Workspace changed. Saving paused.');
      changed.code = 'CALCULATOR_WORKSPACE_CHANGED'; changed.status = 409; changed.permanent = true;
      throw changed;
    }
    return {body:body, headers:{'Content-Type':contentType}};
  }
  function saveSizeError(){
    var error = new Error('This save is too large to transfer. Keep this tab open and download your pending changes before refreshing.');
    error.code = 'CALCULATOR_SAVE_TOO_LARGE';
    error.status = 413;
    error.permanent = true;
    return error;
  }
  function retainPendingSnapshot(request){
    retainRecoveryEnvelope(saveEnvelope(request));
  }
  function retainRecoveryEnvelope(envelope){
    pendingRecovery = {version:1, profile:pendingStorageKey, savedAt:new Date().toISOString(), envelope:envelope};
    try {
      sessionStorage.setItem(pendingStorageKey, JSON.stringify(pendingRecovery));
      recoveryStorageFailed = false;
    } catch(e) { recoveryStorageFailed = true; }
  }
  function clearAcknowledgedRecovery(envelope){
    if (!pendingRecovery || JSON.stringify(pendingRecovery.envelope) !== JSON.stringify(envelope)) return;
    try { sessionStorage.removeItem(pendingStorageKey); pendingRecovery = null; recoveryStorageFailed = false; }
    catch(e) { recoveryStorageFailed = true; }
  }
  function downloadPendingRecovery(){
    if (!pendingRecovery) return;
    var url = URL.createObjectURL(new Blob([JSON.stringify(pendingRecovery, null, 2)], {type:'application/json'}));
    var link = document.createElement('a');
    link.href = url;
    link.download = 'rebate-portal-unsaved-changes.json';
    link.click();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }
  function showRecoveryGuard(){
    if (!document.body || (!workspaceChanged && !recoveryRequired)) return;
    var overlay = document.getElementById('calculatorSaveRecovery');
    if (overlay) return;
    overlay = document.createElement('dialog');
    overlay.id = 'calculatorSaveRecovery';
    overlay.className = 'calculatorSaveRecovery';
    overlay.setAttribute('aria-labelledby', 'calculatorSaveRecoveryTitle');
    overlay.addEventListener('cancel', function(event){ event.preventDefault(); });
    var title = document.createElement('h2');
    title.id = 'calculatorSaveRecoveryTitle';
    title.textContent = workspaceChanged ? 'Workspace changed in another tab' : 'Unsaved changes found';
    var description = document.createElement('p');
    description.textContent = workspaceChanged ? 'This tab has paused to keep different businesses and accounts separate. Reopen this workspace to continue.' : 'A previous save was not confirmed. Your saved calculator is unchanged. Review and download the pending changes before continuing.';
    overlay.append(title, description);
    if (pendingRecovery) {
      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = 'Review pending changes';
      var preview = document.createElement('pre');
      preview.textContent = JSON.stringify(pendingRecovery.envelope.data || pendingRecovery.envelope.quoteArrange || pendingRecovery.envelope.quoteEdit || pendingRecovery.envelope.quoteCopy, null, 2);
      details.append(summary, preview);
      var download = document.createElement('button');
      download.type = 'button';
      download.textContent = 'Download recovery file';
      download.onclick = function(){ downloadPendingRecovery(); proceed.disabled = false; };
      overlay.append(details, download);
    }
    var proceed = document.createElement('button');
    proceed.type = 'button';
    proceed.className = 'secondary';
    proceed.textContent = workspaceChanged ? 'Reopen this workspace' : 'Use saved calculator';
    proceed.disabled = !!pendingRecovery;
    proceed.onclick = function(){
      if (workspaceChanged) { window.location.reload(); return; }
      if (!window.confirm('Continue with the saved cloud version? Pending changes will remain in the recovery file you downloaded and will not be applied automatically.')) return;
      try { sessionStorage.removeItem(pendingStorageKey); }
      catch(e) { description.textContent = 'Recovery storage is unavailable. Keep this tab open and try again.'; return; }
      pendingRecovery = null;
      recoveryRequired = false;
      overlay.close(); overlay.remove();
      scheduleSync();
    };
    overlay.appendChild(proceed);
    document.body.appendChild(overlay);
    overlay.showModal();
  }
  function workspaceIsCurrent(){
    if (workspaceChanged) return false;
    var activeProfile;
    var activeAccount;
    try { activeProfile = localStorage.getItem(profileStorageKey); activeAccount = localStorage.getItem(accountStorageKey); } catch(e) { return false; }
    if (activeProfile === profileEmail && activeAccount === calculatorUser.email) return true;
    workspaceChanged = true;
    clearTimeout(syncRetryTimer); syncRetryTimer = null;
    cloudSaveWaiters.slice().forEach(function(waiter){ settleCloudSaveWaiters(waiter.json, new Error('Workspace changed in another tab. Reopen this workspace to continue.')); });
    setCloudSaveStatus('Workspace changed. Saving paused.', 'error');
    showRecoveryGuard();
    return false;
  }
  function snapshot(){
    var output = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (isAppStorageKey(key)) output[key] = localStorage.getItem(key);
      }
    } catch (e) {}
    // Another tab's localStorage changes cannot upgrade this page's import provenance.
    if (loadedBusinessConfiguration !== null) output[businessConfigurationKey] = loadedBusinessConfiguration;
    else delete output[businessConfigurationKey];
    if (loadedBusinessConfiguration !== null && typeof window.calculatorBusinessSnapshotData === 'function') {
      // A current page must not launder an old tab's storage values under its newer revision.
      ['greenEnergyManagedPricesV1', 'ManagedPricesV1', 'greenEnergyDefaultCostRulesV1', 'DefaultCostRulesV1'].forEach(function(key){ delete output[key]; });
      var businessValues = window.calculatorBusinessSnapshotData();
      Object.keys(businessValues).forEach(function(key){ output[key] = businessValues[key]; });
    }
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
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    certificateRefreshInFlight = true;
    var timeoutId;
    var deadline = new Promise(function(resolve, reject){
      timeoutId = setTimeout(function(){
        if (controller) controller.abort();
        reject(new Error('Certificate value refresh timed out'));
      }, certificateRefreshTimeoutMs);
    });
    var request = Promise.resolve().then(function(){
      return fetch(calculatorSettingsUrl, {
        method: 'GET',
        headers: {'Accept': 'application/json'},
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
    }).then(function(response){
      if (!response.ok) throw new Error('Certificate value refresh failed');
      return response.json();
    });
    return Promise.race([request, deadline]).then(function(result){
      var certificateValue = authoritativeCertificateValue(result && result.data);
      if (typeof window.applyAuthoritativeRebateSettings === 'function') {
        window.applyAuthoritativeRebateSettings(result && result.dcceewContract, certificateValue && certificateValue.value);
      } else if (result && result.dcceewContract && typeof window.applyAuthoritativeDcceewContractData === 'function') {
        window.applyAuthoritativeDcceewContractData(result.dcceewContract);
      }
      if (certificateValue) setCloudValue(certificateValue.key, certificateValue.value);
    }).catch(function(){
    }).finally(function(){
      clearTimeout(timeoutId);
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
        reject(new Error('Current changes could not be confirmed as saved. Keep this tab open and retry save.'));
      }, Math.max(Number(timeoutMs) || 20000, saveRequestTimeoutMs + 1000));
      cloudSaveWaiters.push(waiter);
    });
  }
  function pauseQuoteConflict(error){
    quoteConflictError = error;
    pendingSnapshot = null;
    clearTimeout(timer);
    timer = null;
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
    var waiters = cloudSaveWaiters;
    cloudSaveWaiters = [];
    waiters.forEach(function(waiter){ clearTimeout(waiter.timeout); waiter.reject(error); });
    window.__calculatorQuoteConflict = {code:error.code, status:error.status, message:error.message, currentFamily:error.currentFamily};
    setCloudSaveStatus('Quote options need review', 'error');
    window.dispatchEvent(new CustomEvent('calculator-quote-conflict', {detail:error}));
  }
  function equipmentPriceEditsForSnapshot(data){
    if (typeof window.aadEquipmentPriceEditSnapshot !== 'function') return {};
    try {
      var stored = JSON.parse(data.installerManagedPricesV1 || '{}');
      return Object.fromEntries(Object.entries(window.aadEquipmentPriceEditSnapshot()).filter(function(pair){
        var price = Number(stored[pair[0]] && stored[pair[0]].unitPriceInc);
        return (Number.isFinite(price) && price > 0 ? price : 0) === pair[1].after;
      }));
    } catch(e) { return {}; }
  }
  function sendPendingSnapshot(){
    if (recoveryRequired || !workspaceIsCurrent() || quoteConflictError || quoteArrangeAttempt || syncRetryPaused || syncRetryTimer || syncRequestInFlight || !pendingSnapshot) return;
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
    var request = pendingSnapshot;
    var envelope = saveEnvelope(request);
    var equipmentPriceEdits = envelope.equipmentPriceEdits;
    retainPendingSnapshot(request);
    pendingSnapshot = null;
    syncRequestInFlight = true;
    inFlightSnapshotJson = request.json;
    setCloudSaveStatus('Saving...', 'saving');
    if (recoveryStorageFailed) setCloudSaveStatus('Saving... Recovery storage unavailable; keep this tab open.', 'saving');
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var requestTimeout;
    var deadline = new Promise(function(resolve, reject){
      requestTimeout = setTimeout(function(){
        if (controller) controller.abort();
        reject(new Error('Save confirmation timed out.'));
      }, saveRequestTimeoutMs);
    });
    var saving = saveRequestBody(envelope, controller && controller.signal).then(function(encoded){
      return fetch(calculatorSyncUrl, {method:'PUT', headers:encoded.headers, body:encoded.body, signal:controller && controller.signal});
    }).then(function(response){
      return response.json().catch(function(){ return {}; }).then(function(result){
        if (response.ok && result && result.ok === true) return result;
        var error = response.status === 413 ? saveSizeError() : new Error(result && result.error ? result.error : 'Calculator save was not confirmed. Keep this tab open and retry.');
        error.status = response.status;
        error.code = result.code || error.code;
        error.currentFamily = result.currentFamily;
        var retryAfter = response.headers && response.headers.get('Retry-After');
        error.retryAfterMs = retryAfter ? Math.min(60000, Math.max(0, Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now() || 0)) : 0;
        error.permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409 && response.status !== 429 || error.code === 'QUOTE_OPTION_CONFLICT' || error.code === 'EQUIPMENT_PRICE_CONFLICT' || error.code === 'CALCULATOR_WORKSPACE_CHANGED';
        throw error;
      });
    });
    Promise.race([saving, deadline]).then(function(){
      clearAcknowledgedRecovery(envelope);
      syncFailures = 0;
      syncRetryPaused = false;
      if (typeof window.acknowledgeAadEquipmentPriceEdits === 'function') window.acknowledgeAadEquipmentPriceEdits(equipmentPriceEdits);
      lastSnapshotJson = request.json;
      if (pendingSnapshot && pendingSnapshot.json === lastSnapshotJson) pendingSnapshot = null;
      settleCloudSaveWaiters(request.json, null);
      setCloudSaveStatus(pendingSnapshot ? 'Saving...' : 'Saved', pendingSnapshot ? 'saving' : 'saved');
    }).catch(function(error){
      if (error && error.code === 'QUOTE_OPTION_CONFLICT') {
        pauseQuoteConflict(error);
      } else if (error && error.permanent) {
        if (!pendingSnapshot) pendingSnapshot = request;
        syncRetryPaused = true;
        settleCloudSaveWaiters(request.json, error);
        setCloudSaveStatus(error.code === 'EQUIPMENT_PRICE_CONFLICT' || error.code === 'CALCULATOR_SAVE_TOO_LARGE' ? error.message : 'Save not confirmed. Keep this tab open and retry.', 'error');
        if (error.code === 'CALCULATOR_WORKSPACE_CHANGED') { workspaceChanged = true; showRecoveryGuard(); }
      } else {
        if (!pendingSnapshot) pendingSnapshot = request;
        syncFailures += 1;
        if (syncFailures > syncRetryDelaysMs.length) {
          syncRetryPaused = true;
          var pausedError = new Error('Current changes could not be confirmed as saved. Keep this tab open and retry save.');
          cloudSaveWaiters.slice().forEach(function(waiter){ settleCloudSaveWaiters(waiter.json, pausedError); });
          setCloudSaveStatus('Save not confirmed. Keep this tab open and retry.', 'error');
        } else {
          setCloudSaveStatus('Retrying...', 'retrying');
          var delay = Math.max(syncRetryDelaysMs[syncFailures - 1], error && error.retryAfterMs || 0) + Math.floor(Math.random() * 500);
          syncRetryTimer = setTimeout(function(){
            syncRetryTimer = null;
            sendPendingSnapshot();
          }, delay);
        }
      }
    }).finally(function(){
      if (requestTimeout) clearTimeout(requestTimeout);
      syncRequestInFlight = false;
      inFlightSnapshotJson = '';
      if (!quoteConflictError && !syncRetryPaused && pendingSnapshot && !syncRetryTimer) sendPendingSnapshot();
    });
  }
  function writeSnapshot(force){
    if (recoveryRequired || !workspaceIsCurrent() || quoteConflictError || quoteArrangeAttempt) return;
    var data = snapshot();
    var nextJson = JSON.stringify(data);
    var hasPriceEdits = typeof window.aadEquipmentPriceEditSnapshot === 'function' && Object.keys(window.aadEquipmentPriceEditSnapshot()).length > 0;
    if (!force) {
      if (pendingSnapshot && nextJson === pendingSnapshot.json) return;
      if (syncRequestInFlight && !pendingSnapshot && nextJson === inFlightSnapshotJson) return;
      if (!hasPriceEdits && !syncRequestInFlight && !pendingSnapshot && nextJson === lastSnapshotJson) return;
    }
    pendingSnapshot = {data: data, json: nextJson};
    retainPendingSnapshot(pendingSnapshot);
    sendPendingSnapshot();
  }
  window.__calculatorFlushCloudSave = function(timeoutMs){
    if (recoveryRequired || !workspaceIsCurrent()) return Promise.reject(new Error('Review the pending recovery or reopen this workspace before saving.'));
    if (quoteConflictError) return Promise.reject(quoteConflictError);
    if (quoteArrangeAttempt) return Promise.reject(new Error('Confirm the pending option change before saving more changes.'));
    var data = snapshot();
    var nextJson = JSON.stringify(data);
    var hasPriceEdits = typeof window.aadEquipmentPriceEditSnapshot === 'function' && Object.keys(window.aadEquipmentPriceEditSnapshot()).length > 0;
    if (!hasPriceEdits && !syncRequestInFlight && !pendingSnapshot && nextJson === lastSnapshotJson) {
      return Promise.resolve({ok:true});
    }
    var confirmation = waitForCloudSave(nextJson, timeoutMs);
    pendingSnapshot = {data:data, json:nextJson};
    retainPendingSnapshot(pendingSnapshot);
    if (syncRetryPaused && !syncRequestInFlight) {
      syncRetryPaused = false;
      syncFailures = 0;
    }
    sendPendingSnapshot();
    return confirmation;
  };
  window.__calculatorCanRefresh = function(){
    try {
      if (syncing || recoveryRequired || workspaceChanged || recoveryStorageFailed || quoteConflictError || quoteArrangeAttempt ||
          syncRequestInFlight || pendingSnapshot || pendingRecovery || syncRetryTimer || syncRetryPaused) return false;
      if (Object.keys(refreshBlockedStorageKeys).length) return false;
      if ((typeof currentQuoteTotalsEditing !== 'undefined' && currentQuoteTotalsEditing) ||
          (typeof quoteLibraryEdit !== 'undefined' && quoteLibraryEdit) ||
          (typeof quoteArrangeBusy !== 'undefined' && quoteArrangeBusy) ||
          (typeof quoteArrangePending !== 'undefined' && quoteArrangePending)) return false;
      if (localStorage.getItem(accountStorageKey) !== calculatorUser.email || localStorage.getItem(profileStorageKey) !== profileEmail) return false;
      if (typeof window.aadEquipmentPriceEditSnapshot === 'function' && Object.keys(window.aadEquipmentPriceEditSnapshot()).length) return false;
      return JSON.stringify(snapshot()) === lastSnapshotJson;
    } catch(e) { return false; }
  };
  window.__calculatorResolveQuoteConflict = function(){
    if (!quoteConflictError) return window.__calculatorFlushCloudSave(20000);
    quoteConflictError = null;
    syncRetryPaused = false;
    syncFailures = 0;
    window.__calculatorQuoteConflict = null;
    pendingSnapshot = null;
    clearTimeout(timer);
    timer = null;
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
    return window.__calculatorFlushCloudSave(20000);
  };
  window.__calculatorQuoteRequest = async function(kind, payload, onProgress){
    if (recoveryRequired || !workspaceIsCurrent()) throw new Error('Review recovery or reopen this workspace before saving.');
    if (kind !== 'quoteEdit' && kind !== 'quoteCopy' && kind !== 'quoteArrange') throw new Error('Unsupported quote action.');
    var arrangement = kind === 'quoteArrange';
    var payloadJson = JSON.stringify(payload);
    var retryArrange = quoteArrangeAttempt && quoteArrangeAttempt.kind === kind && quoteArrangeAttempt.payloadJson === payloadJson && !quoteArrangeAttempt.inFlight;
    if (quoteArrangeAttempt && !retryArrange) throw new Error('Confirm the pending option change before starting another request.');
    function progress(stage){ if (typeof onProgress === 'function') { try { onProgress(stage); } catch(e) {} } }
    progress('preparing');
    // Retrying an uncertain move must reach its receipt, not first flush the old layout.
    if (!retryArrange) await window.__calculatorFlushCloudSave(20000);
    if (!retryArrange && quoteArrangeAttempt) throw new Error('Confirm the pending option change before starting another request.');
    quoteArrangeAttempt = {kind:kind, payloadJson:payloadJson, saveId:JSON.parse(payloadJson).saveId, inFlight:true, validResponse:false};
    retainRecoveryEnvelope({[kind]:JSON.parse(payloadJson), businessConfigurationRevision:businessConfigurationRevision, expectedWorkspace:expectedWorkspace});
    progress('saving');
    var controller = new AbortController();
    var timeout = setTimeout(function(){ controller.abort(); }, 15000);
    setCloudSaveStatus('Saving...', 'saving');
    try {
      var encoded = await saveRequestBody({[kind]:JSON.parse(payloadJson), businessConfigurationRevision:businessConfigurationRevision, expectedWorkspace:expectedWorkspace}, controller.signal);
      var response = await fetch(calculatorSyncUrl, {
        method:'PUT', headers:encoded.headers, body:encoded.body, signal:controller.signal
      });
      var result = await response.json().catch(function(){ return {}; });
      if (!response.ok || result.ok !== true) {
        var error = new Error(result.error || (response.ok ? 'The saved quote could not be verified. Retry to confirm the same save.' : 'The quote could not be saved.'));
        error.status = response.status;
        error.code = result.code;
        error.currentFamily = result.currentFamily;
        throw error;
      }
      if (arrangement) {
        var validRecords = function(records, rows){
          return Array.isArray(records) && records.every(function(record){ return record && typeof record.id === 'string' && record.id && (!rows || typeof record.optionId === 'string' && record.optionId); }) && new Set(records.map(function(record){ return record.id; })).size === records.length;
        };
        if (!validRecords(result.defs, false) || !validRecords(result.rows, true) ||
            !Array.isArray(result.removedOptionIds) || !result.removedOptionIds.every(function(id){ return typeof id === 'string'; }) ||
            !Array.isArray(result.removedRowIds) || !result.removedRowIds.every(function(id){ return typeof id === 'string'; })) {
          throw new Error('The saved options could not be verified. Retry to confirm the same save.');
        }
      }
      if (kind === 'quoteEdit' && (!result.row || result.row.id !== payload.rowId || result.row.optionId !== payload.optionId)) throw new Error('The saved system could not be verified. Retry to confirm the same save.');
      if (kind === 'quoteCopy' && (!result.def || !result.def.id || !Array.isArray(result.rows) || !result.rows.length || result.rows.some(function(row){ return !row.id || row.optionId !== result.def.id; }))) throw new Error('The saved copy could not be verified. Retry to confirm the same save.');
      quoteArrangeAttempt.validResponse = true;
      setCloudSaveStatus('Saved', 'saved');
      return result;
    } catch(error) {
      // A rejected retry cannot disprove an earlier committed request with a lost reply.
      if (!retryArrange && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) quoteArrangeAttempt = null;
      setCloudSaveStatus('Quote save not confirmed', 'error');
      if (error.code === 'CALCULATOR_WORKSPACE_CHANGED') { workspaceChanged = true; showRecoveryGuard(); }
      if (error.name === 'AbortError') throw new Error('The save could not be confirmed. Retry to check the same save without creating a duplicate.');
      throw error;
    } finally {
      clearTimeout(timeout);
      if (quoteArrangeAttempt) quoteArrangeAttempt.inFlight = false;
      else scheduleSync();
    }
  };
  window.__calculatorHasPendingQuoteRequest = function(kind){ return !!quoteArrangeAttempt && (!kind || quoteArrangeAttempt.kind === kind); };
  window.__calculatorAcknowledgeQuoteMutation = function(kind, saveId){
    if (!quoteArrangeAttempt || quoteArrangeAttempt.kind !== kind || typeof saveId !== 'string' || !saveId || quoteArrangeAttempt.saveId !== saveId ||
        quoteArrangeAttempt.inFlight || !quoteArrangeAttempt.validResponse) return false;
    if (pendingRecovery && pendingRecovery.envelope[kind] && pendingRecovery.envelope[kind].saveId === saveId) clearAcknowledgedRecovery(pendingRecovery.envelope);
    quoteArrangeAttempt = null;
    scheduleSync();
    return true;
  };
  window.__calculatorAcknowledgeQuoteArrange = function(saveId){ return window.__calculatorAcknowledgeQuoteMutation('quoteArrange', saveId); };
  function retainLocalEdit(){
    if (syncing || recoveryRequired || quoteArrangeAttempt || quoteConflictError) return;
    try {
      var data = snapshot();
      if (JSON.stringify(data) !== lastSnapshotJson) retainPendingSnapshot({data:data});
    } catch(e) {
      recoveryStorageFailed = true;
      setCloudSaveStatus('Local recovery unavailable. Keep this tab open until saving is confirmed.', 'error');
    }
  }
  function scheduleSync(force){
    if (syncing || recoveryRequired || !workspaceIsCurrent() || quoteConflictError || quoteArrangeAttempt) return;
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
    } catch (e) { refreshBlockedStorageKeys.__bootstrap = true; }
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
    var existingAccount = localStorage.getItem(accountStorageKey) || '';
    // Claim the workspace before changing shared storage so older tabs can fence immediately.
    localStorage.setItem(accountStorageKey, calculatorUser.email);
    localStorage.setItem(profileStorageKey, profileEmail);
    if (recoveryRequired || (existingAccount && existingAccount !== calculatorUser.email) || (existingProfile && profileEmail && existingProfile !== profileEmail)) clearAppStorage();
    // Configuration is authoritative business data, never a local/account fallback.
    localStorage.removeItem(${safeScriptJson(BUSINESS_CONFIGURATION_STORAGE_KEY)});
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
    refreshBlockedStorageKeys.__bootstrap = true;
  } finally {
    syncing = false;
  }
  try {
    var originalSetItem = localStorage.setItem.bind(localStorage);
    var originalRemoveItem = localStorage.removeItem.bind(localStorage);
    var originalClear = localStorage.clear.bind(localStorage);
    localStorage.setItem = function(key, value){
      if (isAppStorageKey(key) && !workspaceIsCurrent()) return;
      try { originalSetItem(key, value); delete refreshBlockedStorageKeys[key]; }
      catch(e) { if (isAppStorageKey(key)) refreshBlockedStorageKeys[key] = true; throw e; }
      if (isAppStorageKey(key)) retainLocalEdit();
      scheduleSync();
    };
    localStorage.removeItem = function(key){
      if (isAppStorageKey(key) && !workspaceIsCurrent()) return;
      try { originalRemoveItem(key); delete refreshBlockedStorageKeys[key]; }
      catch(e) { if (isAppStorageKey(key)) refreshBlockedStorageKeys[key] = true; throw e; }
      if (isAppStorageKey(key)) retainLocalEdit();
      scheduleSync();
    };
    localStorage.clear = function(){
      if (!workspaceIsCurrent()) return;
      try { originalClear(); }
      catch(e) { refreshBlockedStorageKeys.__clear = true; throw e; }
      retainLocalEdit();
      scheduleSync();
    };
    document.addEventListener('input', function(){ scheduleSync(); }, true);
    document.addEventListener('change', function(){ scheduleSync(); }, true);
    setInterval(function(){ writeSnapshot(false); }, 5000);
    setInterval(function(){
      if (document.visibilityState === 'visible') refreshAuthoritativeCertificateValues();
    }, certificateRefreshIntervalMs);
    setTimeout(refreshAuthoritativeCertificateValues, 2000);
    window.addEventListener('focus', refreshAuthoritativeCertificateValues);
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'visible') refreshAuthoritativeCertificateValues();
    });
    window.addEventListener('beforeunload', function(event){
      try {
        if (workspaceChanged || recoveryRequired) {
          if (pendingRecovery && event) { event.preventDefault(); event.returnValue = ''; }
          return;
        }
        if (!workspaceIsCurrent()) return;
        var data = snapshot();
        var dirty = JSON.stringify(data) !== lastSnapshotJson || pendingSnapshot || syncRequestInFlight || quoteArrangeAttempt || quoteConflictError;
        if (!dirty) return;
        if (event) { event.preventDefault(); event.returnValue = ''; }
        if (!quoteArrangeAttempt && !quoteConflictError) retainPendingSnapshot({data:data, json:JSON.stringify(data)});
        // Do not create a competing save when the result of another request is uncertain.
        if (quoteConflictError || quoteArrangeAttempt || syncRequestInFlight || syncRetryTimer || syncRetryPaused) return;
        var beacon = new Blob([JSON.stringify(saveEnvelope({data:data}))], {type:'application/json'});
        // Browsers limit the combined unload queue to 64 KiB. Larger pending saves stay recoverable.
        if (beacon.size <= 60000) navigator.sendBeacon(calculatorSyncUrl, beacon);
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
  window.addEventListener('storage', function(event){ if (event.key === profileStorageKey || event.key === accountStorageKey) workspaceIsCurrent(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showRecoveryGuard);
  else showRecoveryGuard();
})();
</script>`;

  return html.replace("<script>", `${bootstrap}\n<script>`);
}

function isMissingBaselineColumn(error: { code?: string } | null) {
  return error?.code === "42703" || error?.code === "PGRST204";
}

function unavailableCalculatorBaseline() {
  return new NextResponse(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calculator temporarily unavailable</title></head><body><main><h1>Calculator temporarily unavailable</h1><p>We could not load your saved calculator. This page has not changed your local data. Try again in a moment.</p><p><a href="">Try again</a></p></main></body></html>',
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "3",
      },
    },
  );
}

async function getApprovedUser(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
) {
  const withGst = await supabase
    .from("approved_users")
    .select("email, display_name, role, business_id, is_locked, commission_type_override, agency_commission_rate_override, salesperson_commission_rate_override, salesperson_gst_registered")
    .eq("email", email)
    .maybeSingle();
  if (!isMissingBaselineColumn(withGst.error)) return withGst;

  const upgraded = await supabase
    .from("approved_users")
    .select(
      "email, display_name, role, business_id, is_locked, commission_type_override, agency_commission_rate_override, salesperson_commission_rate_override",
    )
    .eq("email", email)
    .maybeSingle();

  if (!isMissingBaselineColumn(upgraded.error)) return upgraded;

  return supabase.from("approved_users").select("email, role, business_id, is_locked").eq("email", email).maybeSingle();
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
  if (!isMissingBaselineColumn(upgraded.error)) throw new Error("Business baseline unavailable");

  const { data, error } = await supabase
    .from("businesses")
    .select("id, name, commission_type, agency_commission_rate, salesperson_commission_rate")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error("Business baseline unavailable");
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
  } else if (!["42P01", "PGRST205"].includes(memberships.error.code)) {
    throw new Error("Business membership baseline unavailable");
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

  // A failed read is not an empty saved profile. The browser replaces its
  // baseline with the snapshot from this route when it starts up.
  const useUserIdFallback = viewingEmail === currentEmail && !byEmail.data?.data;
  if (byEmail.error || (useUserIdFallback && byUser.error)) return { loadError: "user" as const };
  if (businessResult.error) return { loadError: "business" as const };
  if (platformResult.error) return { loadError: "platform-values" as const };

  const userData = ((useUserIdFallback ? byUser.data?.data : byEmail.data?.data) || {}) as Record<string, unknown>;
  const platformValues = platformCertificateValuesFromRow(platformResult.data as PlatformCertificateValuesRow | null);
  const businessData = validatedBusinessConfigurationData(
    overlayPlatformCertificateValues((businessResult.data?.data || {}) as Record<string, unknown>, platformValues),
    businessId,
  );

  const unlockedUserData = applyWonAdminUnlocks(userData);
  const cleanedUserData = withoutBusinessConfiguration(stripCertificateValueKeys(unlockedUserData));
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
  const { data: approvedUser, error: approvalError } = await getApprovedUser(supabase, currentEmail);
  if (approvalError) return unavailableCalculatorBaseline();

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
  const { data: viewedApprovedUser, error: viewedApprovalError } =
    viewingEmail === currentEmail
      ? { data: approved, error: null }
      : await getApprovedUser(supabase, viewingEmail);
  if (viewedApprovalError) return unavailableCalculatorBaseline();
  if (!viewedApprovedUser) return new NextResponse("Viewed account not available", { status: 403 });
  const viewedUser = viewedApprovedUser as ApprovedUser;
  const currentUserIsOwner = isOwnerEmail(currentEmail);
  let business: Business | null;
  try {
    business = await resolveActiveBusiness(
      supabase,
      viewedUser,
      effectiveRequestedBusinessId,
      currentUserIsOwner,
    );
  } catch {
    return unavailableCalculatorBaseline();
  }
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
  if ("loadError" in savedDataResult) {
    return unavailableCalculatorBaseline();
  }
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

  let additions: ReturnType<typeof calculatorAddedProducts> = [];
  if (businessOperatingState === "NSW") {
    try { additions = calculatorAddedProducts(await readAddedModels()); }
    catch { console.error("Verified model additions could not be loaded"); }
  }
  const prices = business?.id && String(business.operating_state || "").trim().toUpperCase() === "NSW" ? aadCataloguePrices : null;
  const catalogueHtml = (await calculatorHtmlPromise).replace("<script>", `<script>window.__verifiedCatalogueAdditions=${safeScriptJson(additions)};window.__aadCataloguePrices=${safeScriptJson(prices)};</script>\n<script>`);
  const html = injectCloudStorageSync(
    catalogueHtml,
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
      salespersonGstRegistered: viewedUser.salesperson_gst_registered !== false,
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

  const currentHtml = injectCalculatorUpdateNotice(html, calculatorReleaseVersion());
  return calculatorTransferResponse(request, currentHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
