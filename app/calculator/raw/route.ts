import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

function safeScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function injectCloudStorageSync(html: string, data: Record<string, unknown>) {
  const bootstrap = `
<script>
(function(){
  var cloudData = ${safeScriptJson(data)};
  var syncing = false;
  var timer = null;
  function snapshot(){
    var output = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key) output[key] = localStorage.getItem(key);
      }
    } catch (e) {}
    return output;
  }
  function scheduleSync(){
    if (syncing) return;
    clearTimeout(timer);
    timer = setTimeout(function(){
      fetch('/api/calculator-data', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({data: snapshot()})
      }).catch(function(){});
    }, 700);
  }
  try {
    syncing = true;
    Object.keys(cloudData || {}).forEach(function(key){
      if (typeof cloudData[key] === 'string') localStorage.setItem(key, cloudData[key]);
    });
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
    window.addEventListener('beforeunload', function(){
      try {
        navigator.sendBeacon('/api/calculator-data', new Blob([JSON.stringify({data: snapshot()})], {type: 'application/json'}));
      } catch(e) {}
    });
  } catch (e) {}
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
    .select("email")
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
  );

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
