"use client";

import { useState } from "react";

type SelectOption = {
  label: string;
  value: string;
};

export default function AutoSubmitSelect({
  action = "/calculator",
  ariaLabel,
  className,
  hiddenFields = [],
  label,
  loadingLabel,
  name,
  options,
  value,
}: {
  action?: string;
  ariaLabel: string;
  className?: string;
  hiddenFields?: Array<{ name: string; value: string }>;
  label: string;
  loadingLabel: string;
  name: string;
  options: SelectOption[];
  value: string;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <form
      action={action}
      method="get"
      className={className}
      data-loading-label={loadingLabel}
    >
      {hiddenFields.map((field) => (
        <input key={field.name} type="hidden" name={field.name} value={field.value} />
      ))}
      <label className="auto-submit-label">
        <span>{label}</span>
        <select
          name={name}
          defaultValue={value}
          aria-label={ariaLabel}
          disabled={isSubmitting}
          onChange={(event) => {
            const form = event.currentTarget.form;
            if (!form) return;
            setIsSubmitting(true);
            form.requestSubmit();
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </form>
  );
}
