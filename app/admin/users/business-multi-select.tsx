"use client";

import { useEffect, useState } from "react";

type BusinessOption = {
  id: string;
  name: string;
};

function normalizedSelection(businesses: BusinessOption[], selectedIds: string[]) {
  const availableIds = new Set(businesses.map((business) => business.id));
  return Array.from(new Set(selectedIds.filter((id) => availableIds.has(id))));
}

function selectionLabel(businesses: BusinessOption[], selectedIds: string[]) {
  if (!businesses.length) return "No businesses available";
  const selected = businesses.filter((business) => selectedIds.includes(business.id));
  if (!selected.length) return "No business selected";
  if (selected.length === 1) return selected[0].name;
  return selected.length + " businesses selected";
}

export default function BusinessMultiSelect({
  businesses,
  selectedIds,
}: {
  businesses: BusinessOption[];
  selectedIds: string[];
}) {
  const [selected, setSelected] = useState(() => normalizedSelection(businesses, selectedIds));

  useEffect(() => {
    setSelected(normalizedSelection(businesses, selectedIds));
  }, [businesses, selectedIds]);

  function updateSelection(businessId: string, checked: boolean) {
    setSelected((current) => {
      if (checked) return Array.from(new Set([...current, businessId]));
      return current.filter((id) => id !== businessId);
    });
  }

  function closeOtherMenus(current: HTMLDetailsElement) {
    if (!current.open) return;
    document.querySelectorAll<HTMLDetailsElement>(".business-multiselect[open]").forEach((details) => {
      if (details !== current) details.open = false;
    });
  }

  return (
    <details
      className="business-multiselect"
      onToggle={(event) => closeOtherMenus(event.currentTarget)}
    >
      <summary className="business-multiselect-summary">
        <span className="business-multiselect-label">
          {selectionLabel(businesses, selected)}
        </span>
        <span aria-hidden="true">v</span>
      </summary>
      <div className="business-multiselect-menu">
        {businesses.map((business) => (
          <label className="checkbox-pill" key={business.id}>
            <input
              type="checkbox"
              name="businessIds"
              value={business.id}
              checked={selected.includes(business.id)}
              onChange={(event) => updateSelection(business.id, event.currentTarget.checked)}
            />
            <span>{business.name}</span>
          </label>
        ))}
        {!businesses.length ? <span className="empty-select-note">Add a business first.</span> : null}
      </div>
    </details>
  );
}
