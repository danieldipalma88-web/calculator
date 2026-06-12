import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { canManageUsers } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

function safeScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

type CalculatorUserContext = {
  email: string;
  role: string;
  canManageUsers: boolean;
};

function injectCloudStorageSync(
  html: string,
  data: Record<string, unknown>,
  userContext: CalculatorUserContext,
) {
  const bootstrap = `
<script>
(function(){
  var cloudData = ${safeScriptJson(data)};
  var calculatorUser = ${safeScriptJson(userContext)};
  var profileStorageKey = '__calculatorProfileEmail';
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
  function writeSnapshot(force){
    var data = snapshot();
    var nextJson = JSON.stringify(data);
    if (!force && nextJson === lastSnapshotJson) return;
    lastSnapshotJson = nextJson;
    fetch('/api/calculator-data', {
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
  function applyRoleUi(){
    if (calculatorUser && calculatorUser.canManageUsers) return;
    var certButton = document.getElementById('certValuesActionBtn');
    if (certButton) certButton.style.display = 'none';
    var certDrawer = document.getElementById('certDrawer');
    if (certDrawer) certDrawer.style.display = 'none';
    window.openCertDrawer = function(){ return false; };
  }
  try {
    syncing = true;
    clearAppStorage();
    Object.keys(cloudData || {}).forEach(function(key){
      if (isAppStorageKey(key) && typeof cloudData[key] === 'string') localStorage.setItem(key, cloudData[key]);
    });
    localStorage.setItem(profileStorageKey, calculatorUser.email || '');
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
        navigator.sendBeacon('/api/calculator-data', new Blob([JSON.stringify({data: snapshot()})], {type: 'application/json'}));
      } catch(e) {}
    });
  } catch (e) {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyRoleUi);
  else applyRoleUi();
})();
</script>`;

  return html.replace("<script>", `${bootstrap}\n<script>`);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.redirect("/");
  }

  const { data: approvedUser } = await supabase
    .from("approved_users")
    .select("email, role")
    .eq("email", user.email.toLowerCase())
    .maybeSingle();

  if (!approvedUser) {
    return new NextResponse("Not approved", { status: 403 });
  }

  const { data: savedData } = await supabase
    .from("user_calculator_data")
    .select("data")
    .eq("user_id", user.id)
    .maybeSingle();

  const calculatorPath = path.join(process.cwd(), "index.html");
  const html = injectCloudStorageSync(
    await readFile(calculatorPath, "utf8"),
    (savedData?.data || {}) as Record<string, unknown>,
    {
      email: user.email.toLowerCase(),
      role: String(approvedUser.role || "user"),
      canManageUsers: canManageUsers(user.email, approvedUser.role),
    },
  );

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
