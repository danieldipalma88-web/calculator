import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, adminSource, invitationSource] = await Promise.all([
  readFile(new URL("../app/signin-button.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/supabase/approved-user-invitation.ts", import.meta.url), "utf8"),
]);

assert.match(source, /signInWithOtp\(\{\s*email:\s*trimmedEmail,\s*\}\)/s);
assert.doesNotMatch(source, /emailRedirectTo/);
assert.match(source, /verifyOtp\(\{\s*email:\s*submittedEmail,\s*token,\s*type:\s*"email",\s*\}\)/s);
assert.match(source, /autoComplete="one-time-code"/);
assert.match(source, /inputMode="numeric"/);
assert.match(source, /const EMAIL_OTP_LENGTH = 8/);
assert.match(source, /pattern="\[0-9\]\{8\}"/);
assert.match(source, /Send login code/);
assert.match(source, /Verify and sign in/);
assert.match(source, /Resend code/);
assert.match(source, /Change email/);
assert.match(source, /safeNextPath\(next\)/);

assert.match(invitationSource, /supabase\.auth\.signInWithOtp\(\{/);
assert.match(invitationSource, /email,/);
assert.match(invitationSource, /shouldCreateUser:\s*true/);
assert.match(adminSource, /await sendApprovedUserInvitation\(supabase, email\)/);
assert.match(adminSource, /was approved, but the invitation email could not be sent/);
assert.match(adminSource, /is approved and has been emailed a login code/);

console.log("email code login checks ok");
