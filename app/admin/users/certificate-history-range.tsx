"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

type CertificateHistoryRange = "4w" | "3m" | "6m" | "1y" | "all";

const OPTIONS: { value: CertificateHistoryRange; label: string }[] = [
  { value: "4w", label: "Last 4 weeks" },
  { value: "3m", label: "Last 3 months" },
  { value: "6m", label: "Last 6 months" },
  { value: "1y", label: "Last year" },
  { value: "all", label: "All time" },
];

export default function CertificateHistoryRangeSelect({ value }: { value: CertificateHistoryRange }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="certificate-history-range">
      <span>Time range</span>
      <select
        value={value}
        disabled={isPending}
        onChange={(event) => {
          const params = new URLSearchParams(searchParams.toString());
          params.set("certificateHistoryRange", event.target.value);
          startTransition(() => {
            router.push(`${pathname}?${params.toString()}#certificate-price-history`);
          });
        }}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <small aria-live="polite">{isPending ? "Updating history..." : ""}</small>
    </label>
  );
}
