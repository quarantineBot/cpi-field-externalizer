// Regression tests for the Parameter Value Manager engine. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/engine/pvm.js');
const { parseProfile, serializeProfile, valuesForEnv, diffValues, validate, plan } = globalThis.__CpixPVM;

test('parseProfile: JSON canonical round-trips', () => {
  const p = { version: 1, iflow: 'x', environments: ['DEV', 'QA'], parameters: { A: { DEV: '1', QA: '2' }, B: { DEV: 'b' } } };
  const back = parseProfile(serializeProfile(p, 'json'), 'json');
  assert.deepEqual(back, p);
});

test('parseProfile: simple single-env JSON normalizes', () => {
  const p = parseProfile(JSON.stringify({ iflow: 'x', environment: 'QA', parameters: { A: 'a', B: 'b' } }));
  assert.deepEqual(p.environments, ['QA']);
  assert.deepEqual(p.parameters, { A: { QA: 'a' }, B: { QA: 'b' } });
});

test('parseProfile/serialize: CSV multi-env with quoted commas', () => {
  const csv = 'Name,DEV,QA\nOData_address,"https://a.com/x,y",https://qa.com\nAlias,DEV_CRED,QA_CRED\n';
  const p = parseProfile(csv, 'csv');
  assert.deepEqual(p.environments, ['DEV', 'QA']);
  assert.equal(p.parameters.OData_address.DEV, 'https://a.com/x,y'); // comma preserved
  assert.equal(p.parameters.Alias.QA, 'QA_CRED');
  // re-serialize keeps the comma quoted
  assert.match(serializeProfile(p, 'csv'), /"https:\/\/a\.com\/x,y"/);
});

test('valuesForEnv picks one environment column', () => {
  const p = parseProfile('Name,DEV,QA\nA,1,2\nB,,9\n', 'csv');
  assert.deepEqual(valuesForEnv(p, 'QA'), { A: '2', B: '9' });
  assert.deepEqual(valuesForEnv(p, 'DEV'), { A: '1' }); // B has no DEV value
});

test('diffValues classifies changed/added/removed', () => {
  const d = diffValues({ A: '1', B: 'x' }, { A: '2', C: 'new' });
  assert.deepEqual(d.changed, [{ name: 'A', from: '1', to: '2' }]);
  assert.deepEqual(d.added, [{ name: 'C', to: 'new' }]);
  assert.deepEqual(d.removed, [{ name: 'B', from: 'x' }]);
});

test('validate flags missing, stale, at-default (blank CSV cell = missing)', () => {
  const iflow = { params: ['A', 'B', 'C'], defaults: { A: 'da', B: 'db', C: 'dc' } };
  const profile = parseProfile('Name,PROD\nA,prod-a\nB,\nC,dc\nD,stale\n', 'csv');
  const v = validate(iflow, profile, 'PROD');
  assert.deepEqual(v.missing, ['B']);       // blank CSV cell = no value provided for PROD
  assert.deepEqual(v.stale, ['D']);         // D not in iflow
  assert.deepEqual(v.atDefault, ['C']);     // C equals its default → risky in PROD
  assert.equal(v.ok, false);
});

test('validate flags empty when JSON sets an explicit ""', () => {
  const iflow = { params: ['A', 'B'], defaults: {} };
  const profile = parseProfile(JSON.stringify({ environment: 'PROD', parameters: { A: 'a', B: '' } }));
  const v = validate(iflow, profile, 'PROD');
  assert.deepEqual(v.empty, ['B']);         // explicit "" → empty (not missing)
  assert.deepEqual(v.missing, []);
});

test('validate: missing detected when env value absent', () => {
  const iflow = { params: ['A', 'B'], defaults: {} };
  const profile = parseProfile('Name,QA\nA,1\n', 'csv');
  assert.deepEqual(validate(iflow, profile, 'QA').missing, ['B']);
});

test('plan computes sets/unchanged/unknown and reset-to-default warning', () => {
  const state = {
    params: ['A', 'B', 'C', 'D'],
    defaults: { A: 'da', B: 'db', C: 'dc', D: 'dd' },
    configured: { A: 'liveA', D: 'liveD' },
  };
  const target = { A: 'liveA', B: 'newB', C: 'dc', D: 'dd', Z: 'ghost' };
  const r = plan(state, target);
  // A: live == target → unchanged. C: no configured, current=default 'dc' == target → unchanged (no write).
  assert.deepEqual(r.unchanged.sort(), ['A', 'C']);
  assert.deepEqual(r.unknown, ['Z']);                            // Z not a param
  // B: default→newB (a real change). D: liveD→'dd' which equals its default (reset).
  assert.deepEqual(r.sets.map((s) => s.name).sort(), ['B', 'D']);
  const b = r.sets.find((s) => s.name === 'B');
  assert.equal(b.from, 'db'); assert.equal(b.atDefault, false);
  const d = r.sets.find((s) => s.name === 'D');
  assert.equal(d.from, 'liveD'); assert.equal(d.atDefault, true); // setting D back to its default
  assert.deepEqual(r.atDefaultAfter, ['D']);
});
