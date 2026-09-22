export type SearchableSelectOption = { label: string; secondaryLabel?: string; value: string };

export function filterSelectOptions<T extends SearchableSelectOption>(options: T[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => [option.label, option.secondaryLabel, option.value]
    .filter(Boolean).some((candidate) => candidate!.toLocaleLowerCase().includes(normalizedQuery)));
}
