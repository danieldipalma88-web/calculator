import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compare against the exact local release used to start this UI-only branch.
const baseline = execFileSync('git', ['show', 'f00620b:index.html'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const candidate = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const script = (html) => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n');
const functions = (html) => {
  const source = ts.createSourceFile('calculator.js', script(html), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return new Map(source.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node.getText(source)]));
};
const before = functions(baseline), after = functions(candidate);
const presentationChanges = new Set(['updateCalculatorSectionVisibility', 'renderMultiSplitFinancials', 'renderMultiSplitTrial', 'updateMainOptionNameInput', 'refreshQuoteChoiceDestination']);
for (const [name, source] of before) {
  assert.ok(after.has(name), `Existing function retained: ${name}`);
  if (!presentationChanges.has(name)) assert.equal(after.get(name), source, `Unchanged logic: ${name}`);
}
assert.deepEqual([...after.keys()].filter((name) => !before.has(name)), ['updateMultiWorkspaceDestination']);
const range = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
for (const [label, start, end] of [
  ['standard split and ducted markup', '<div class="grid" id="standardCalculatorSection">', '<div class="multiSplitTrialCard'],
  ['all-models markup', '<div class="allModelsCard"', '<div class="floatingActionBar"'],
]) assert.equal(range(candidate, start, end), range(baseline, start, end), label);
assert.doesNotMatch(candidate, /split-workspace\.(?:js|css)/, 'Abandoned split redesign is not included');
assert.equal((candidate.match(/id="multiFinalInc"/g) || []).length, 1, 'One editable multi-head customer price');
assert.equal((candidate.match(/id="multiSplitQuickRebateBtn"/g) || []).length, 1, 'One multi-head rebate action');
console.log(`PASS: ${before.size - presentationChanges.size} existing functions unchanged; split/ducted/all-models markup unchanged; no abandoned split assets.`);
