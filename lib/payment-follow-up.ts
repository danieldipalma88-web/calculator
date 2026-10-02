export type PaymentFollowUpJob = {
  proposedInstallationDate: string;
  paymentRequestedAt: string;
  paidInAt: string;
  paidOutAt: string;
  agencyCommissionTotal: number;
  salespersonCommissionTotal: number;
};

export type PaymentFollowUp = {
  kind: "request-payment" | "follow-up-payment" | "pay-commission" | "check-date";
  label: string;
  daysSinceInstall: number | null;
  amount: number;
};

export function sydneyToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
}

function dateDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return null;
  return time / 86400000;
}

export function paymentFollowUp(job: PaymentFollowUpJob, today: string): PaymentFollowUp | null {
  const positiveAmount = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
  const incoming = !job.paidInAt ? positiveAmount(job.agencyCommissionTotal) : 0;
  const outgoing = !job.paidOutAt ? positiveAmount(job.salespersonCommissionTotal) : 0;
  if (!incoming && !outgoing) return null;
  const installDay = dateDay(job.proposedInstallationDate);
  const currentDay = dateDay(today);
  if (currentDay === null) return null;
  if (installDay === null) {
    return { kind: "check-date", label: "Check install date", daysSinceInstall: null, amount: incoming || outgoing };
  }
  const daysSinceInstall = currentDay - installDay;
  if (daysSinceInstall <= 0) return null;
  // These are follow-up reminders, not contractual due dates or proof of installation.
  if (incoming) {
    const followUp = Boolean(job.paymentRequestedAt || job.paidOutAt);
    return {
      kind: followUp ? "follow-up-payment" : "request-payment",
      label: followUp ? "Follow up payment" : "Request payment",
      daysSinceInstall, amount: incoming,
    };
  }
  return { kind: "pay-commission", label: "Pay commission", daysSinceInstall, amount: outgoing };
}
