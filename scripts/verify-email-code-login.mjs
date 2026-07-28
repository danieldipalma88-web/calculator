import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/signin-button.tsx", import.meta.url), "utf8");

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

console.log("email code login checks ok");
