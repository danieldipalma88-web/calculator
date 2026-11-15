const code = value => String(value || '').toUpperCase().replace(/\s+/g, '');
const setLabel = /^(?:(?:set|system|combination|combined)\s+)?model(?:\s+(?:number|no\.?))?$/i;
const indoorLabel = /^indoor(?:\s+unit)?\s+model(?:\s+(?:number|no\.?))?$/i;
const outdoorLabel = /^outdoor(?:\s+unit)?\s+model(?:\s+(?:number|no\.?))?$/i;

export function tableMapping(items, mapping) {
  if (items.length > 12000) throw new Error('Manufacturer page exceeds the text-item limit');
  const valid = items.filter(item => typeof item.str === 'string' && item.str.length <= 300
    && Number.isFinite(item.transform?.[4]) && Number.isFinite(item.transform?.[5]) && Number.isFinite(item.width));
  const labels = valid.filter(item => [setLabel, indoorLabel, outdoorLabel].some(re => re.test(item.str.trim())));
  if (labels.length > 120) throw new Error('Manufacturer page exceeds the table limit');
  const atRow = (label, model, anchorCenter) => valid.filter(item => code(item.str) === code(model)
    && item.transform[4] > label.transform[4] + label.width
    && Math.abs(item.transform[5] - label.transform[5]) <= 2
    && (anchorCenter === undefined || Math.abs(item.transform[4] + item.width / 2 - anchorCenter) <= 4));
  for (const anchor of labels.filter(item => setLabel.test(item.str.trim()))) {
    const systems = atRow(anchor, mapping.model);
    if (systems.length !== 1) continue;
    const center = systems[0].transform[4] + systems[0].width / 2;
    // The next two labels in this label column must be indoor and outdoor.
    // A second set-model row starts a different table and cannot be skipped.
    const below = labels.filter(item => Math.abs(item.transform[4] - anchor.transform[4]) <= 4
      && item.transform[5] < anchor.transform[5] - 2 && anchor.transform[5] - item.transform[5] <= 60)
      .sort((a, b) => b.transform[5] - a.transform[5]);
    if (below.length < 2 || !indoorLabel.test(below[0].str.trim()) || !outdoorLabel.test(below[1].str.trim())) continue;
    if (anchor.transform[5] - below[0].transform[5] > 25 || below[0].transform[5] - below[1].transform[5] > 25) continue;
    if (atRow(below[0], mapping.indoor, center).length === 1 && atRow(below[1], mapping.outdoor, center).length === 1) return true;
  }
  return false;
}
