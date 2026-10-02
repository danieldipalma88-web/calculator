"use client";

import { useRef, useState } from "react";
import { requestUserRemoval } from "../../../lib/admin-user-removal-client";
import { useUserRemoval } from "./directory-list";

export default function RemoveUserButton({ email, disabled = false }: { email: string; disabled?: boolean }) {
  const onRemoved = useUserRemoval();
  const busy = useRef(false);
  const [state, setState] = useState<"idle" | "removing" | "checking" | "uncertain" | "removed">("idle");
  const [message, setMessage] = useState("");

  async function run(checkOnly: boolean) {
    if (busy.current || disabled) return;
    if (!checkOnly && !window.confirm(`Remove calculator access for ${email}? Saved quotes and payment records will be retained.`)) return;
    busy.current = true;
    setState(checkOnly ? "checking" : "removing");
    setMessage("");
    try {
      const result = await requestUserRemoval(email, checkOnly);
      if (result.removed) {
        setState("removed");
        setMessage("Calculator access removed.");
        onRemoved(email);
      } else {
        setState("idle");
        setMessage("This user currently still has access. You can try removing them again.");
      }
    } catch (error) {
      setState("uncertain");
      setMessage(error instanceof Error ? error.message : "Removal has not been confirmed. Check the user's current access.");
    } finally {
      busy.current = false;
    }
  }

  const pending = state === "removing" || state === "checking";
  return <div className="user-removal-control" aria-busy={pending}>
    {state !== "removed" && <button className={state === "uncertain" ? "secondary" : "danger"} type="button"
      disabled={disabled || pending} onClick={() => void run(state === "uncertain")}>
      {state === "removing" ? "Removing user..." : state === "checking" ? "Checking access..." : state === "uncertain" ? "Check removal status" : "Remove"}
    </button>}
    {message && <p role="status" className="help">{message}</p>}
  </div>;
}
