"use client";

import { useEffect, useState } from "react";

type LoadingState = {
  label: string;
  visible: boolean;
};

function LoadingView({ label, visible }: LoadingState) {
  return (
    <div
      className="page-loading-overlay"
      aria-busy={visible}
      aria-hidden={!visible}
      aria-live="polite"
      hidden={!visible}
    >
      <div className="page-loading-panel">
        <span className="page-loading-spinner" aria-hidden="true" />
        <strong>{label}</strong>
        <span>Please wait while the latest information is loaded.</span>
      </div>
    </div>
  );
}

function useNavigationLoading(
  initialVisible: boolean,
  initialLabel: string,
  captureForms: boolean,
) {
  const [loading, setLoading] = useState<LoadingState>({
    label: initialLabel,
    visible: initialVisible,
  });

  useEffect(() => {
    if (!captureForms) return;

    function show(label: string) {
      setLoading({ label: label || "Loading...", visible: true });
    }

    function handleSubmit(event: SubmitEvent) {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (!form || form.closest(".won-options-section")) return;
      const submitter = event.submitter instanceof HTMLElement ? event.submitter : null;
      const label =
        form.dataset.loadingLabel ||
        submitter?.dataset.loadingLabel ||
        (submitter?.textContent ? `${submitter.textContent.trim()}...` : "Saving changes...");
      show(label);
    }

    function handleClick(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-loading-label]") : null;
      if (!target || target.closest("form")) return;
      if (target instanceof HTMLAnchorElement) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (target.target && target.target !== "_self") return;
      }
      show(target.dataset.loadingLabel || "Loading...");
    }

    document.addEventListener("submit", handleSubmit, true);
    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("submit", handleSubmit, true);
      document.removeEventListener("click", handleClick, true);
    };
  }, [captureForms]);

  useEffect(() => {
    document.body.classList.toggle("page-loading-active", loading.visible);
    return () => document.body.classList.remove("page-loading-active");
  }, [loading.visible]);

  return { loading, setLoading };
}

export default function PageLoadingOverlay({
  initial = false,
  initialLabel = "Loading...",
  captureForms = true,
}: {
  initial?: boolean;
  initialLabel?: string;
  captureForms?: boolean;
}) {
  const { loading } = useNavigationLoading(initial, initialLabel, captureForms);
  return <LoadingView {...loading} />;
}

export function CalculatorFrame({ src }: { src: string }) {
  const { loading, setLoading } = useNavigationLoading(true, "Loading calculator...", true);

  return (
    <>
      <iframe
        className="calculator-frame"
        src={src}
        title="Quote calculator"
        onLoad={() => setLoading((current) => ({ ...current, visible: false }))}
      />
      <LoadingView {...loading} />
    </>
  );
}

export function AuthenticationLoadingOverlay({ visible }: { visible: boolean }) {
  return <LoadingView label="Signing in securely..." visible={visible} />;
}
