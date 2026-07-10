// Regression tests for the externalization engine. Zero-dependency: run with `node --test`.
//
// These lock two things that are easy to break: the detection heuristics, and the exact
// parameters.prop / parameters.propdef byte-format (pinned to real CPI output).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// engine.js is environment-agnostic; importing it populates the global.
await import('../src/engine/engine.js');
const { analyze, apply, classify, analyzeModel, applyModel } = globalThis.__CpixEngine;

const IFLW_PATH = 'src/main/resources/scenarioflows/integrationflow/x.iflw';

// Build a minimal iFlow model from a list of [step, key, value] property triples.
function makeIflw(props) {
  const body = props
    .map(([, key, value]) => `<ifl:property><key>${key}</key><value>${value}</value></ifl:property>`)
    .join('');
  // group all props under one named messageFlow per distinct step
  const bySteps = new Map();
  for (const [step, key, value] of props) {
    if (!bySteps.has(step)) bySteps.set(step, []);
    bySteps.get(step).push(`<ifl:property><key>${key}</key><value>${value}</value></ifl:property>`);
  }
  const flows = [...bySteps.entries()]
    .map(([step, ps], i) => `<bpmn2:messageFlow id="m${i}" name="${step}"><bpmn2:extensionElements>${ps.join('')}</bpmn2:extensionElements></bpmn2:messageFlow>`)
    .join('');
  void body;
  return `<?xml version="1.0"?><bpmn2:definitions xmlns:bpmn2="a" xmlns:ifl="b"><bpmn2:collaboration>${flows}</bpmn2:collaboration></bpmn2:definitions>`;
}

// ---------------------------------------------------------------------------
test('classify: high / medium / skipped', () => {
  assert.equal(classify('address', 'https://x')?.confidence, 'high');
  assert.equal(classify('credentialName', 'ABC')?.confidence, 'high');
  assert.equal(classify('host', 'sftp.acme.com')?.confidence, 'high');
  assert.equal(classify('connectTimeout', '5000')?.confidence, 'medium');
  assert.equal(classify('path', '/in/orders')?.confidence, 'medium');

  assert.equal(classify('address', '{{Already}}'), null);   // already externalized
  assert.equal(classify('id', '${header.x}'), null);         // runtime expression
  assert.equal(classify('componentVersion', '1.5'), null);   // structural deny-key
  assert.equal(classify('enabled', 'true'), null);           // boolean
  assert.equal(classify('proxyType', 'internet'), null);     // not env config
});

// ---------------------------------------------------------------------------
test('analyze: detects candidates and skips the rest (sample fixture)', async () => {
  const iflw = await readFile(
    fileURLToPath(new URL('./fixtures/SampleIflow/src/main/resources/scenarioflows/integrationflow/Sample.iflw', import.meta.url)),
    'utf8',
  );
  const { candidates, totalProperties } = analyze({ [IFLW_PATH]: iflw });

  assert.equal(totalProperties, 14);
  assert.equal(candidates.length, 7);

  const keys = candidates.map((c) => c.key).sort();
  assert.deepEqual(keys, ['address', 'connectTimeout', 'credentialName', 'host', 'path', 'targetSystemUrl', 'userName']);

  // skipped ones must be absent
  for (const skipped of ['componentVersion', 'proxyHost', 'correlationId', 'bodyType', 'proxyType']) {
    assert.ok(!candidates.some((c) => c.key === skipped), `${skipped} should be skipped`);
  }

  // contextual, unique names
  const byKey = Object.fromEntries(candidates.map((c) => [c.key, c]));
  assert.equal(byKey.address.suggestedName, 'HTTP_Receiver_URL');
  assert.equal(byKey.userName.suggestedName, 'SFTP_Sender_Credential');
  assert.equal(new Set(candidates.map((c) => c.suggestedName)).size, candidates.length);
});

// ---------------------------------------------------------------------------
test('apply: fresh parameters.propdef matches CPI format byte-for-byte', () => {
  const iflw = makeIflw([
    ['HTTP Receiver', 'address', 'https://api.acme.com/v1'],
    ['HTTP Receiver', 'credentialName', 'ACME_CRED'],
  ]);
  const { files } = apply({ [IFLW_PATH]: iflw }, [
    { id: 0, paramName: 'Recv_URL' },
    { id: 1, paramName: 'Recv_Cred' },
  ]);

  const expectedPropdef =
`<?xml version="1.0" encoding="UTF-8" standalone="no"?><parameters><parameter>
    <key/>
    <name>Recv_URL</name>
    <type>xsd:string</type>
    <isRequired>false</isRequired>
    <constraint/>
    <description/>
    <additionalMetadata/>
  </parameter><parameter>
    <key/>
    <name>Recv_Cred</name>
    <type>xsd:string</type>
    <isRequired>false</isRequired>
    <constraint/>
    <description/>
    <additionalMetadata/>
  </parameter><param_references/></parameters>`;

  assert.equal(files['src/main/resources/parameters.propdef'], expectedPropdef);
});

// ---------------------------------------------------------------------------
test('apply: fresh parameters.prop has a header and Java-escaped values', () => {
  const iflw = makeIflw([['Rcv', 'address', 'https://legacy.acme.internal:8443/api']]);
  const { files } = apply({ [IFLW_PATH]: iflw }, [{ id: 0, paramName: 'URL' }]);

  const lines = files['src/main/resources/parameters.prop'].split('\n');
  assert.match(lines[0], /^#/); // Java-style timestamp header
  // both colons escaped (scheme and port)
  assert.equal(lines[1], 'URL=https\\://legacy.acme.internal\\:8443/api');
});

// ---------------------------------------------------------------------------
test('apply: rewrites only selected values in the .iflw', () => {
  const iflw = makeIflw([
    ['S', 'address', 'https://a.com'],
    ['S', 'credentialName', 'CRED'],
    ['S', 'other', 'https://keep.com'],
  ]);
  const { files } = apply({ [IFLW_PATH]: iflw }, [
    { id: 0, paramName: 'A' },
    { id: 1, paramName: 'C' },
  ]);
  const out = files[IFLW_PATH];
  assert.ok(out.includes('<value>{{A}}</value>'));
  assert.ok(out.includes('<value>{{C}}</value>'));
  assert.ok(out.includes('<value>https://keep.com</value>')); // id 2 not selected
});

// ---------------------------------------------------------------------------
test('apply: merges into an existing propdef before <param_references/>', () => {
  const iflw = makeIflw([['HTTP Receiver', 'credentialName', 'PROD_CRED']]);
  const existingPropdef =
`<?xml version="1.0" encoding="UTF-8" standalone="no"?><parameters><parameter>
    <key/>
    <name>Target_URL</name>
    <type>xsd:string</type>
    <isRequired>false</isRequired>
    <constraint/>
    <description/>
    <additionalMetadata/>
  </parameter><param_references/></parameters>`;
  const existingProp = '#Fri Apr 17 18:38:44 UTC 2026\nTarget_URL=https\\://x.com/w\n';

  const { files } = apply(
    {
      [IFLW_PATH]: iflw,
      'src/main/resources/parameters.prop': existingProp,
      'src/main/resources/parameters.propdef': existingPropdef,
    },
    [{ id: 0, paramName: 'Recv_Cred' }],
  );

  const propdef = files['src/main/resources/parameters.propdef'];
  // existing preserved, exactly one references node and one root close
  assert.equal((propdef.match(/<param_references\/>/g) || []).length, 1);
  assert.equal((propdef.match(/<\/parameters>/g) || []).length, 1);
  assert.ok(propdef.includes('<name>Target_URL</name>'));
  assert.ok(propdef.includes('<name>Recv_Cred</name>'));
  // new param comes before the references node; Target_URL comes before the new one
  assert.ok(propdef.indexOf('<name>Recv_Cred</name>') < propdef.indexOf('<param_references/>'));
  assert.ok(propdef.indexOf('<name>Target_URL</name>') < propdef.indexOf('<name>Recv_Cred</name>'));

  const prop = files['src/main/resources/parameters.prop'];
  assert.ok(prop.startsWith('#Fri Apr 17'));       // header preserved
  assert.ok(prop.includes('\nTarget_URL=https\\://x.com/w')); // existing preserved
  assert.ok(prop.trimEnd().endsWith('Recv_Cred=PROD_CRED')); // new appended last
});

// ---------------------------------------------------------------------------
test('apply: a value reused across steps yields one param entry, both rewritten', () => {
  const iflw = makeIflw([
    ['A', 'address', 'https://same.com'],
    ['B', 'address', 'https://same.com'],
  ]);
  const { files, applied } = apply({ [IFLW_PATH]: iflw }, [
    { id: 0, paramName: 'Shared' },
    { id: 1, paramName: 'Shared' },
  ]);
  // both occurrences rewritten
  assert.equal((files[IFLW_PATH].match(/\{\{Shared\}\}/g) || []).length, 2);
  // exactly one prop line for the shared name
  const propLines = files['src/main/resources/parameters.prop'].split('\n').filter((l) => l.startsWith('Shared='));
  assert.equal(propLines.length, 1);
  assert.equal(applied.length, 2);
});

// ---------------------------------------------------------------------------
test('idempotent: re-analyzing an externalized model finds no new candidates', () => {
  const iflw = makeIflw([['S', 'address', 'https://a.com']]);
  const { files } = apply({ [IFLW_PATH]: iflw }, [{ id: 0, paramName: 'A' }]);
  const again = analyze({ [IFLW_PATH]: files[IFLW_PATH] });
  assert.equal(again.candidates.length, 0);
});

// ---- live editor-model path (analyzeModel / applyModel) -------------------
// Mirrors the real CPI save model: Content Modifier fields live in
// propertyViewModel.listOfDefaultFlowElementModel[i].allTableAttributes.{headerTable|propertyTable}.
function makeModel() {
  const cell = (v) => ({ value: v, defaultValue: '', key: '' });
  return {
    version: '1.0',
    bpmnModel: {}, galileiModel: {},
    listOfExternalizedPropertiesModel: [],
    propertyViewModel: {
      listOfDefaultFlowElementModel: [
        {
          id: 'CallActivity_1', name: 'Set Target', activityType: 'Enricher', displayName: 'Content Modifier',
          allTableAttributes: {
            headerTable: { value: [
              { Type: { value: 'constant' }, Name: { value: 'Accept' }, Value: cell('application/json') },
              { Type: { value: 'constant' }, Name: { value: 'credentialName' }, Value: cell('ACME_CRED') },
            ] },
            propertyTable: { value: [
              { Type: { value: 'constant' }, Name: { value: 'Endpoint' }, Value: cell('https://api.acme.com/v1') },
              { Type: { value: 'expression' }, Name: { value: 'Corr' }, Value: cell('${header.x}') },
            ] },
          },
        },
        { id: 'Gw', name: 'Router', activityType: 'ExclusiveGateway', allTableAttributes: {} },
      ],
    },
  };
}

test('analyzeModel: finds Content Modifier header/property candidates, skips the rest', () => {
  const { candidates } = analyzeModel(makeModel());
  const byName = Object.fromEntries(candidates.map((c) => [c.fieldName, c]));
  assert.equal(candidates.length, 2);                       // Accept + expression + gateway skipped
  assert.equal(byName.credentialName.field, 'header');
  assert.equal(byName.credentialName.confidence, 'high');
  assert.equal(byName.Endpoint.field, 'property');
  assert.equal(byName.Endpoint.suggestedName, 'Endpoint');  // field name reused as param name
  assert.equal(byName.credentialName.recommended, true);
  assert.ok(!byName.Accept && !byName.Corr);

  // "show all" surfaces non-detected constant fields too (Accept), still skipping expressions
  const all = analyzeModel(makeModel(), { includeAll: true }).candidates;
  const allByName = Object.fromEntries(all.map((c) => [c.fieldName, c]));
  assert.equal(all.length, 3);
  assert.equal(allByName.Accept.recommended, false);
  assert.equal(allByName.credentialName.recommended, true);
  assert.ok(!allByName.Corr);                               // expression still skipped
});

test('applyModel: externalizes cells and adds list entries matching CPI shape', () => {
  const m = makeModel();
  const { candidates } = analyzeModel(m);
  const sel = candidates.map((c) => ({ id: c.id, paramName: c.suggestedName }));
  const { model, applied } = applyModel(m, sel);
  assert.equal(applied.length, 2);

  const els = model.propertyViewModel.listOfDefaultFlowElementModel;
  const hdr = els[0].allTableAttributes.headerTable.value[1].Value;   // credentialName
  const prop = els[0].allTableAttributes.propertyTable.value[0].Value; // Endpoint
  assert.equal(hdr.key, 'credentialName');
  assert.equal(hdr.defaultValue, 'ACME_CRED');
  assert.equal(hdr.isModified, true);
  assert.deepEqual(hdr.additionalMetadata, {});                        // header gets it
  assert.equal(prop.key, 'Endpoint');
  assert.equal(prop.additionalMetadata, undefined);                    // property does not

  const ext = model.listOfExternalizedPropertiesModel;
  assert.equal(ext.length, 2);
  const cred = ext.find((e) => e.propertyObj.key === 'credentialName');
  assert.equal(cred.propertyObj.value, 'ACME_CRED');
  assert.equal(cred.propertyObj.dataType, 'xsd:string');
  assert.equal(cred.listOfReferences[0].bindingPath, '/listOfDefaultFlowElementModel/0/allTableAttributes/headerTable/value/1');
  assert.equal(cred.listOfReferences[0].displayName, 'Content Modifier');

  // input model was not mutated (applyModel works on a copy)
  assert.equal(makeModel().listOfExternalizedPropertiesModel.length, 0);
  // idempotent: re-analyzing finds nothing new
  assert.equal(analyzeModel(model).candidates.length, 0);
});

// ---- adapter (channel) path -----------------------------------------------
// Adapter config lives in propertyViewModel.listOfDefaultChannelModel[i].allAttributes.
function makeChannelModel() {
  const cell = (v) => ({ value: v, defaultValue: '', key: '', isPersisted: true });
  return {
    bpmnModel: {}, galileiModel: {}, listOfExternalizedPropertiesModel: [],
    propertyViewModel: {
      listOfDefaultFlowElementModel: [],
      listOfDefaultChannelModel: [
        {
          id: 'MessageFlow_1', name: { value: 'OData' }, adapterType: { value: 'HCIOData' }, direction: { value: 'Receiver' },
          allAttributes: {
            address: cell('https://svc.acme.com/odata'),
            scc_location_id: cell('acme-cc'),
            proxyType: cell('sapcc'),
          },
        },
      ],
    },
  };
}

test('analyzeModel: detects adapter (channel) fields', () => {
  const byName = Object.fromEntries(analyzeModel(makeChannelModel()).candidates.map((c) => [c.fieldName, c]));
  assert.equal(Object.keys(byName).length, 2);            // address + scc_location_id; proxyType skipped
  assert.equal(byName.address.field, 'adapter');
  assert.equal(byName.address.confidence, 'high');
  assert.equal(byName.address.suggestedName, 'OData_address');
  assert.ok(byName.scc_location_id);                      // 'location' → detected
  assert.ok(!byName.proxyType);
  assert.equal(analyzeModel(makeChannelModel(), { includeAll: true }).candidates.length, 3); // + proxyType
});

test('applyModel: externalizes an adapter field with a DEFAULT_CHANNEL ref', () => {
  const { model, applied } = applyModel(makeChannelModel(), [{ id: 'ch:0:address', paramName: 'ODATA_ADDRESS' }]);
  assert.equal(applied.length, 1);
  const cell = model.propertyViewModel.listOfDefaultChannelModel[0].allAttributes.address;
  assert.equal(cell.key, 'ODATA_ADDRESS');
  assert.equal(cell.defaultValue, 'https://svc.acme.com/odata');
  assert.equal(cell.isModified, true);
  assert.equal(cell.additionalMetadata, undefined);       // adapters don't get additionalMetadata
  const entry = model.listOfExternalizedPropertiesModel.find((e) => e.propertyObj.key === 'ODATA_ADDRESS');
  const ref = entry.listOfReferences[0];
  assert.equal(ref.IType, 'DEFAULT_CHANNEL');
  assert.equal(ref.id, 'MessageFlow_1');
  assert.equal(ref.adapterType, 'HCIOData');
  assert.equal(ref.name, 'OData');
  assert.equal(ref.bindingPath, '/allAttributes/address/value/0/value');
  assert.equal(entry.isTable, undefined);                 // no isTable for adapters
  assert.equal(makeChannelModel().listOfExternalizedPropertiesModel.length, 0); // input not mutated
});
