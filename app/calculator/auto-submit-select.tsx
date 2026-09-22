"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./auto-submit-select.module.css";
import { filterSelectOptions } from "./auto-submit-select-utils";

type SelectOption = { label: string; secondaryLabel?: string; value: string };

export default function AutoSubmitSelect({ action = "/calculator", ariaLabel, className, hiddenFields = [], label, loadingLabel, name, options, value }: {
  action?: string; ariaLabel: string; className?: string; hiddenFields?: Array<{ name: string; value: string }>;
  label: string; loadingLabel: string; name: string; options: SelectOption[]; value: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedValue, setSelectedValue] = useState(value);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const valueInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const listboxId = useId();
  const selectedOption = options.find((option) => option.value === selectedValue) || options[0];
  const filteredOptions = filterSelectOptions(options, query);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    searchRef.current?.focus();
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [isOpen]);

  useEffect(() => {
    setSelectedValue(value);
    setIsSubmitting(false);
  }, [value]);

  useEffect(() => {
    const restoreFromPageCache = () => {
      setSelectedValue(value);
      setIsSubmitting(false);
    };
    window.addEventListener("pageshow", restoreFromPageCache);
    return () => window.removeEventListener("pageshow", restoreFromPageCache);
  }, [value]);

  useEffect(() => {
    const activeOption = filteredOptions[activeIndex];
    if (isOpen && activeOption) {
      optionRefs.current.get(activeOption.value)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, filteredOptions, isOpen]);

  function openMenu(direction?: "first" | "last") {
    setQuery("");
    setIsOpen(true);
    setActiveIndex(direction === "last" ? Math.max(options.length - 1, 0) : 0);
  }

  function closeMenu(restoreFocus = true) {
    setIsOpen(false);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  }

  function chooseOption(option: SelectOption) {
    if (isSubmitting || option.value === selectedValue) return closeMenu();
    setSelectedValue(option.value);
    setIsSubmitting(true);
    setIsOpen(false);
    if (valueInputRef.current) valueInputRef.current.value = option.value;
    formRef.current?.requestSubmit();
  }

  function moveActive(direction: 1 | -1) {
    if (!filteredOptions.length) return;
    setActiveIndex((current) => (current + direction + filteredOptions.length) % filteredOptions.length);
  }

  return <form ref={formRef} action={action} method="get" className={[styles.form, className].filter(Boolean).join(" ")} data-loading-label={loadingLabel}>
    {hiddenFields.map((field) => <input key={field.name} type="hidden" name={field.name} value={field.value} />)}
    <input ref={valueInputRef} type="hidden" name={name} value={selectedValue} readOnly />
    <div
      ref={rootRef}
      className={styles.root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu(false);
      }}
    >
      <span className={styles.label}>{label}</span>
      <button ref={triggerRef} type="button" className={styles.trigger} aria-label={`${ariaLabel}: ${selectedOption?.label || "Choose an option"}`} aria-expanded={isOpen} aria-controls={listboxId} aria-haspopup="listbox" disabled={isSubmitting}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); openMenu("first"); }
          if (event.key === "ArrowUp") { event.preventDefault(); openMenu("last"); }
          if (event.key === "Escape" && isOpen) { event.preventDefault(); closeMenu(); }
        }}>
        <span className={styles.selectedLabel}>{selectedOption?.label || "Choose an option"}</span><span className={styles.chevron} aria-hidden="true" />
      </button>
      {isOpen ? <div className={styles.menu}>
        <input ref={searchRef} type="search" role="combobox" className={styles.search} value={query} placeholder={`Search ${label.toLowerCase()}`} aria-label={`Search ${label.toLowerCase()}`} aria-expanded={isOpen} aria-controls={listboxId}
          aria-activedescendant={filteredOptions[activeIndex] ? `${listboxId}-${filteredOptions[activeIndex].value}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); moveActive(1); }
            if (event.key === "ArrowUp") { event.preventDefault(); moveActive(-1); }
            if (event.key === "Enter") { event.preventDefault(); const option = filteredOptions[activeIndex]; if (option) chooseOption(option); }
            if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
          }} />
        <div id={listboxId} className={styles.options} role="listbox" aria-label={ariaLabel}>
          {filteredOptions.map((option, index) => <button ref={(element) => {
            if (element) optionRefs.current.set(option.value, element);
            else optionRefs.current.delete(option.value);
          }} id={`${listboxId}-${option.value}`} key={option.value} type="button" role="option" tabIndex={-1} aria-selected={option.value === selectedValue}
            className={[styles.option, index === activeIndex ? styles.activeOption : "", option.value === selectedValue ? styles.currentOption : ""].filter(Boolean).join(" ")}
            onMouseMove={() => setActiveIndex(index)} onClick={() => chooseOption(option)}>
            <span className={styles.optionLabel}>{option.label}</span>{option.secondaryLabel ? <span className={styles.secondaryLabel}>{option.secondaryLabel}</span> : null}
          </button>)}
        </div>
        {!filteredOptions.length ? <p className={styles.empty} role="status" aria-live="polite">No results found.</p> : null}
      </div> : null}
    </div>
  </form>;
}
