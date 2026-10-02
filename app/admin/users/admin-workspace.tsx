"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useSearchParams } from "next/navigation";

const VIEWS = [
  { id: "businesses", label: "Businesses", panel: "businesses" },
  { id: "users", label: "Users", panel: "approved-users" },
  { id: "jobs", label: "Won Jobs", panel: "won-options" },
  { id: "prices", label: "Spot Prices", panel: "certificate-values" },
] as const;
type View = typeof VIEWS[number]["id"];
const ViewContext = createContext<View>("businesses");
const validView = (value: unknown): value is View => VIEWS.some((view) => view.id === value);

function hashView() {
  const hash = window.location.hash;
  if (/certificate|spot-prices/.test(hash)) return "prices";
  if (/approved-user|new-approved-user|assign-approved-user/.test(hash)) return "users";
  if (/won-options/.test(hash)) return "jobs";
  if (/businesses|new-business/.test(hash)) return "businesses";
  return null;
}

export function AdminPanel({ view, id, className = "", children }: {
  view: View; id: string; className?: string; children: ReactNode;
}) {
  const active = useContext(ViewContext);
  return <section id={id} data-admin-panel={view} role="tabpanel" aria-labelledby={`admin-tab-${view}`}
    className={`admin-section ${className}`} hidden={active !== view} tabIndex={-1}>{children}</section>;
}

export function AdminSaveStatus() {
  const { pending } = useFormStatus();
  const marker = useRef<HTMLParagraphElement>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const form = marker.current?.closest("form");
    if (!form || !pending) { setSlow(false); return; }
    form.setAttribute("aria-busy", "true");
    const buttons = Array.from(form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')).filter((button) => !button.disabled);
    buttons.forEach((button) => { button.disabled = true; });
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => {
      clearTimeout(timer);
      form.removeAttribute("aria-busy");
      buttons.forEach((button) => { button.disabled = false; });
    };
  }, [pending]);
  return <p ref={marker} className="admin-save-status" role="status" hidden={!pending}>
    {slow ? "This is taking longer than usual. Your request is still processing." : "Saving changes..."}
  </p>;
}

export default function AdminWorkspace({ children, storageScope, initialView }: {
  children: ReactNode; storageScope: string; initialView?: View;
}) {
  const [view, setView] = useState<View>(initialView || "businesses");
  const root = useRef<HTMLDivElement>(null);
  const params = useSearchParams();
  const resultKey = params.toString();
  const storageKey = `calculator-admin-workspace-v1:${storageScope}`;

  useEffect(() => {
    let saved: { view?: View; expanded?: string[]; returning?: boolean; scrollY?: number } = {};
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || "{}"); } catch { /* Storage is optional. */ }
    const nextView = hashView() || initialView || saved.view;
    if (validView(nextView)) setView(nextView);
    const frame = requestAnimationFrame(() => {
      root.current?.querySelectorAll<HTMLDetailsElement>("details[data-admin-record]").forEach((record) => {
        if (saved.expanded?.includes(record.dataset.adminRecord || "")) record.open = true;
      });
      if (saved.returning) {
        window.scrollTo({ top: saved.scrollY || 0, behavior: "instant" });
        try { sessionStorage.setItem(storageKey, JSON.stringify({ ...saved, returning: false })); } catch { /* Optional. */ }
      }
    });
    const onHash = () => { const next = hashView(); if (next) setView(next); };
    window.addEventListener("hashchange", onHash);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", onHash); };
  }, [storageKey, initialView, resultKey]);

  useEffect(() => {
    const node = root.current;
    const onToggle = () => remember();
    node?.addEventListener("toggle", onToggle, true);
    return () => node?.removeEventListener("toggle", onToggle, true);
  }, [view, resultKey]);

  function remember(returning = false, nextView = view) {
    const expanded = Array.from(root.current?.querySelectorAll<HTMLDetailsElement>("details[data-admin-record][open]") || [])
      .map((record) => record.dataset.adminRecord);
    try { sessionStorage.setItem(storageKey, JSON.stringify({ view: nextView, expanded, returning, scrollY: window.scrollY })); } catch { /* Optional. */ }
  }

  function selectView(next: View) {
    remember(false, next);
    setView(next);
    const target = VIEWS.find((item) => item.id === next)!;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${target.panel}`);
  }

  return <ViewContext.Provider value={view}>
    <div ref={root} className="admin-workspace" data-admin-workspace
      onSubmitCapture={(event) => {
        if (!(event.target instanceof HTMLFormElement)) return;
        const form = event.target;
        if (form.getAttribute("aria-busy") === "true") { event.preventDefault(); return; }
        if (!form.closest(".won-options-section")) {
          const confirmation = form.dataset.confirmMessage;
          if (confirmation && !window.confirm(confirmation)) { event.preventDefault(); return; }
        }
        remember(true);
      }}>
      <nav className="admin-tabs" role="tablist" aria-label="Platform admin sections">
        {VIEWS.map((item, index) => <button id={`admin-tab-${item.id}`} key={item.id} type="button" role="tab"
          aria-selected={view === item.id} aria-controls={item.panel} tabIndex={view === item.id ? 0 : -1}
          onClick={() => selectView(item.id)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            const next = event.key === "Home" ? VIEWS[0] : event.key === "End" ? VIEWS[VIEWS.length - 1] : VIEWS[(index + step + VIEWS.length) % VIEWS.length];
            selectView(next.id);
            document.getElementById(`admin-tab-${next.id}`)?.focus();
          }}>{item.label}</button>)}
      </nav>
      {children}
    </div>
  </ViewContext.Provider>;
}
