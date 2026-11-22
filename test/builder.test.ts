import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTiers, norm, resolveSelections } from '../src/cart/builder.js';
import { fixture } from './helpers.js';

const product = fixture('product');

test('norm folds case, accents and final sigma', () => {
  assert.equal(norm('Μέτριος'), norm('ΜΕΤΡΙΟΣ'));
  assert.equal(norm('Μέτριος'), 'μετριοσ');
});

test('names resolve to option codes and the price adds up', () => {
  const r = resolveSelections(product, ['regular', 'μετριος', 'καστανη']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.selected.map((o) => o.code), ['515.1894', '945.28665', '946.28669']);
  assert.equal(r.unitPrice, 2.5); // 0.10 base + 2.40 regular
});

test('an exact name wins over a longer name that starts the same', () => {
  const r = resolveSelections(product, ['Regular', 'Μέτριος']);
  assert.equal(r.selected[1].name, 'Μέτριος');
});

test('option codes are accepted as they are', () => {
  const r = resolveSelections(product, ['515.1895', '945.28667']);
  assert.deepEqual(r.errors, []);
  assert.equal(r.unitPrice, 4);
});

test('a required choice is never guessed', () => {
  const r = resolveSelections(product, ['regular']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /choose one for "Επιλέξτε ζάχαρη"/);
});

test('an unknown option is an error', () => {
  const r = resolveSelections(product, ['regular', 'σκετος', 'ketchup']);
  assert.deepEqual(r.errors, ['no option matches "ketchup"']);
});

test('an ambiguous name is an error, not a guess', () => {
  const r = resolveSelections(product, ['regular', 'σκετος', 'γαλα']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /ambiguous/);
});

test('two choices in a single-choice group are rejected', () => {
  const r = resolveSelections(product, ['regular', 'grande', 'σκετος']);
  assert.ok(r.errors.some((e) => /takes one choice/.test(e)));
});

test('a conditional group cannot be used when its condition is not met', () => {
  // Sugar type only applies when the coffee has sugar.
  const r = resolveSelections(product, ['regular', 'σκετος', 'stevia']);
  assert.ok(r.errors.some((e) => /does not apply/.test(e)));
});

test('an out-of-stock option is rejected', () => {
  const copy = structuredClone(product) as any;
  copy.tiers[0].options[0].shortage = true;
  const r = resolveSelections(copy, ['regular', 'σκετος']);
  assert.ok(r.errors.some((e) => /out of stock/.test(e)));
});

test('a single-option required group is filled in', () => {
  const item = { price: 1, tiers: [{ code: 1, name: 'Size', type: 'radio', options: [{ code: '1.1', name: 'One size', price: 2 }] }] };
  const r = resolveSelections(item, []);
  assert.deepEqual(r.errors, []);
  assert.equal(r.unitPrice, 3);
});

test('describeTiers marks required and conditional groups', () => {
  const tiers = describeTiers(product);
  assert.equal(tiers[0].required, true);
  assert.equal(tiers[2].required, false);
  assert.equal(tiers[2].conditional, true);
  assert.equal(tiers[2].max, 1);
});
