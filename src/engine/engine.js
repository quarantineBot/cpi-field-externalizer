// engine.js — dependency-free externalization core.
//
// Environment-agnostic: runs as a classic script inside the browser plugin (attaches to
// globalThis.__CpixEngine) and as a module in the Node test harness (module.exports).
//
// Pipeline: analyze(files) -> candidates -> apply(files, selections) -> new files.
// `files` is a plain object { "relative/path": "utf8 string" }.

(function (root) {
  'use strict';

  // ======================================================================
  // scan — locate the .iflw model and extract every <ifl:property> block
  // ======================================================================
  // CPI stores each configurable value as a machine-generated block:
  //   <ifl:property><key>address</key><value>https://api.acme.com</value></ifl:property>
  // Any literal "<" inside a value is XML-escaped, so a bounded regex is safe & portable.
  const PROP_RE =
    /<ifl:property>\s*<key>([\s\S]*?)<\/key>\s*<value>([\s\S]*?)<\/value>\s*<\/ifl:property>/gd;

  const STEP_TAGS = [
    'bpmn2:messageFlow', 'bpmn2:callActivity', 'bpmn2:serviceTask', 'bpmn2:participant',
    'bpmn2:startEvent', 'bpmn2:endEvent', 'bpmn2:exclusiveGateway', 'bpmn2:process',
  ];

  function findIflowPath(files) {
    return Object.keys(files).find((p) => p.endsWith('.iflw')) || null;
  }

  function xmlUnescape(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  function enclosingStep(text, offset) {
    const before = text.slice(0, offset);
    let bestIdx = -1;
    let bestTag = null;
    for (const tag of STEP_TAGS) {
      const i = before.lastIndexOf('<' + tag);
      if (i > bestIdx) { bestIdx = i; bestTag = tag; }
    }
    if (bestIdx === -1) return { name: '', type: '' };
    const head = before.slice(bestIdx, bestIdx + 500);
    const nameM = head.match(/\sname="([^"]*)"/);
    return { name: nameM ? xmlUnescape(nameM[1]) : '', type: bestTag.replace('bpmn2:', '') };
  }

  function scanProperties(iflw) {
    const blocks = [];
    let m;
    let i = 0;
    PROP_RE.lastIndex = 0;
    while ((m = PROP_RE.exec(iflw)) !== null) {
      const valueRange = m.indices[2];
      const step = enclosingStep(iflw, m.index);
      blocks.push({
        index: i++,
        key: m[1].trim(),
        value: xmlUnescape(m[2]).trim(),
        valueStart: valueRange[0],
        valueEnd: valueRange[1],
        stepName: step.name,
        stepType: step.type,
      });
    }
    return blocks;
  }

  // ======================================================================
  // naming
  // ======================================================================
  function sanitize(s) {
    return String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_');
  }
  function suggestName(stepName, hint, key) {
    return [sanitize(stepName), sanitize(hint || key)].filter(Boolean).join('_') || 'Param';
  }
  function uniqueName(name, used) {
    if (!used.has(name)) return name;
    let i = 2;
    while (used.has(`${name}_${i}`)) i++;
    return `${name}_${i}`;
  }

  // ======================================================================
  // params — parameters.prop (key=value) and parameters.propdef (XML)
  // ======================================================================
  // Formats pinned to real CPI (Integration Suite, CF) output — see mergePropdef below.
  function parseProp(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('!')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1);
    }
    return out;
  }
  // Java Properties value escaping, matching CPI's parameters.prop output: the colon in a
  // URL is written as "\:". Escapes \ = : # ! and control chars; a leading space too.
  function escapePropValue(v) {
    let out = '';
    const s = String(v);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') out += '\\\\';
      else if (c === '\t') out += '\\t';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\f') out += '\\f';
      else if (c === '=' || c === ':' || c === '#' || c === '!') out += '\\' + c;
      else if (c === ' ') out += i === 0 ? '\\ ' : ' ';
      else out += c;
    }
    return out;
  }

  // CPI writes a Java-style timestamp header, e.g. "#Fri Apr 17 18:38:44 UTC 2026".
  function javaTimestamp(d) {
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const p = (n) => String(n).padStart(2, '0');
    return `${day} ${mon} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
  }

  function appendProp(text, entries) {
    if (!entries.length) return text || '';
    let base = text || '';
    if (!base) base = `#${javaTimestamp(new Date())}\n`;   // fresh file: header like CPI
    else if (!/\n$/.test(base)) base += '\n';
    return base + entries.map((e) => `${e.name}=${escapePropValue(e.value)}`).join('\n') + '\n';
  }

  // parameters.propdef — exact CPI shape: <parameter> children directly under <parameters>,
  // <param_references/> last; fields key/name/type/isRequired/constraint/description/
  // additionalMetadata (no <externalized_parameters> wrapper, no <default_value>).
  const PROPDEF_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';
  function paramBlock(name, type) {
    return `<parameter>
    <key/>
    <name>${name}</name>
    <type>${type || 'xsd:string'}</type>
    <isRequired>false</isRequired>
    <constraint/>
    <description/>
    <additionalMetadata/>
  </parameter>`;
  }
  function mergePropdef(text, params) {
    const blocks = params.map((p) => paramBlock(p.name, p.dataType)).join('');
    const t = text || '';
    if (!blocks) return t || `${PROPDEF_DECL}<parameters><param_references/></parameters>`;
    if (/<param_references\s*\/>/.test(t)) return t.replace(/<param_references\s*\/>/, blocks + '<param_references/>');
    if (t.includes('</parameters>')) return t.replace('</parameters>', blocks + '<param_references/></parameters>');
    return `${PROPDEF_DECL}<parameters>${blocks}<param_references/></parameters>`;
  }

  // ======================================================================
  // detect — classify property values and propose parameter names
  // ======================================================================
  const DENY_KEYS = new Set([
    'componentVersion', 'cmdVariantUri', 'ComponentType', 'ComponentNS', 'ComponentSWCVName',
    'TransportProtocol', 'MessageProtocol', 'direction', 'Name', 'Description', 'bean', 'id',
    'activityType', 'interfaceName', 'system', 'namespaceMapping', 'wsdlURL_current',
  ]);
  const PROP_PATHS = ['src/main/resources/parameters.prop', 'parameters.prop'];
  const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function classify(key, value) {
    const v = String(value || '').trim();
    if (!v) return null;
    if (/^\{\{[\s\S]*\}\}$/.test(v)) return null;
    if (v.includes('${')) return null;
    if (DENY_KEYS.has(key)) return null;
    if (/^(true|false)$/i.test(v)) return null;

    if (/:\/\//.test(v)) return { reason: 'URL / endpoint', hint: 'URL', confidence: 'high' };
    if (/credential|alias|username|(^|_)user$|secret|token|password|apikey|api_key/i.test(key))
      return { reason: 'Credential / user', hint: 'Credential', confidence: 'high' };
    if (/host|server|endpoint|address|(^|_)url$|(^|_)uri$/i.test(key))
      return { reason: 'Host / address', hint: 'Address', confidence: 'high' };
    if (/path|directory|(^|_)dir$|location|folder/i.test(key))
      return { reason: 'Path / directory', hint: 'Path', confidence: 'medium' };
    if (/port|timeout|pagesize|page_size|retry|interval|poolsize/i.test(key))
      return { reason: 'Numeric config', hint: capFirst(key), confidence: 'medium' };
    if (/queue|topic|channel|destination|mailbox/i.test(key))
      return { reason: 'Queue / topic / destination', hint: capFirst(key), confidence: 'medium' };
    if (/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(v) || /^\d{1,3}(\.\d{1,3}){3}$/.test(v))
      return { reason: 'Hostname / IP value', hint: 'Host', confidence: 'medium' };
    return null;
  }

  function analyze(files) {
    const iflowPath = findIflowPath(files);
    if (!iflowPath) throw new Error('No .iflw model found in the artifact.');
    const blocks = scanProperties(files[iflowPath]);

    const existing = parseProp(PROP_PATHS.map((p) => files[p]).find(Boolean) || '');
    const used = new Set(Object.keys(existing));

    const candidates = [];
    for (const b of blocks) {
      const c = classify(b.key, b.value);
      if (!c) continue;
      const name = uniqueName(suggestName(b.stepName, c.hint, b.key), used);
      used.add(name);
      candidates.push({
        id: b.index, key: b.key, value: b.value, stepName: b.stepName, stepType: b.stepType,
        suggestedName: name, reason: c.reason, confidence: c.confidence,
      });
    }
    return { iflowPath, candidates, existingParams: existing, totalProperties: blocks.length };
  }

  // ======================================================================
  // apply — write chosen externalizations back into the file map
  // ======================================================================
  const PROP_PATH = 'src/main/resources/parameters.prop';
  const PROPDEF_PATH = 'src/main/resources/parameters.propdef';
  function pickPath(files, preferred, legacy) {
    if (files[preferred] !== undefined) return preferred;
    if (files[legacy] !== undefined) return legacy;
    return preferred;
  }

  function apply(files, selections) {
    const out = { ...files };
    const iflowPath = findIflowPath(files);
    if (!iflowPath) throw new Error('No .iflw model found in the artifact.');

    const byId = new Map(scanProperties(files[iflowPath]).map((b) => [b.index, b]));
    const resolved = selections
      .map((s) => ({ ...s, block: byId.get(s.id) }))
      .filter((s) => s.block)
      .sort((a, b) => b.block.valueStart - a.block.valueStart); // splice from the end

    let iflw = files[iflowPath];
    const applied = [];
    for (const s of resolved) {
      const { block } = s;
      iflw = iflw.slice(0, block.valueStart) + `{{${s.paramName}}}` + iflw.slice(block.valueEnd);
      applied.push({ name: s.paramName, value: block.value, key: block.key, step: block.stepName, dataType: s.dataType });
    }
    out[iflowPath] = iflw;

    const propPath = pickPath(files, PROP_PATH, 'parameters.prop');
    const propdefPath = pickPath(files, PROPDEF_PATH, 'parameters.propdef');
    const seen = new Set(Object.keys(parseProp(files[propPath] || '')));

    const propEntries = [];
    const propdefParams = [];
    for (const a of applied.slice().reverse()) { // restore document order
      if (seen.has(a.name)) continue;
      seen.add(a.name);
      propEntries.push({ name: a.name, value: a.value });
      propdefParams.push({ name: a.name, dataType: a.dataType || 'xsd:string' });
    }
    out[propPath] = appendProp(files[propPath] || '', propEntries);
    out[propdefPath] = mergePropdef(files[propdefPath] || '', propdefParams);

    return { files: out, applied, iflowPath };
  }

  // ======================================================================
  // JSON editor-model externalization (LIVE in-editor path)
  // ======================================================================
  // The CPI design editor persists a JSON model via PUT to the iflows endpoint. Content
  // Modifier header/property values live in
  //   propertyViewModel.listOfDefaultFlowElementModel[i].allTableAttributes.{headerTable|propertyTable}.value[r].Value
  // A non-externalized cell has Value.key === ""; externalizing sets Value.key to the
  // parameter name (+ defaultValue, isModified; headers also get additionalMetadata:{}) and
  // adds an entry to listOfExternalizedPropertiesModel that references the cell by bindingPath.
  // galileiModel / bpmnModel do NOT carry these values, so they are left untouched.

  const valOf = (x) => (x && typeof x === 'object' && 'value' in x) ? x.value : x;
  function flowElements(model) { return (model && model.propertyViewModel && model.propertyViewModel.listOfDefaultFlowElementModel) || []; }
  function channels(model) { return (model && model.propertyViewModel && model.propertyViewModel.listOfDefaultChannelModel) || []; }

  // Scan the editor model for externalizable fields — Content Modifier header/property
  // cells and adapter (channel) scalar attributes.
  // opts.includeAll: return every eligible field (not just auto-detected ones), each flagged
  // with `recommended`, so the UI can let the user opt in to any field.
  function analyzeModel(model, opts) {
    const includeAll = !!(opts && opts.includeAll);
    const used = new Set((model.listOfExternalizedPropertiesModel || []).map((e) => e.propertyObj && e.propertyObj.key).filter(Boolean));
    const candidates = [];
    const consider = (fieldName, value, make) => {
      const c = classify(fieldName || 'value', value);
      if (!c && !includeAll) return;
      const cand = make(c);
      cand.suggestedName = uniqueName(cand.suggestedName, used);
      used.add(cand.suggestedName);
      cand.recommended = !!c;
      cand.reason = c ? c.reason : '';
      cand.confidence = c ? c.confidence : 'low';
      candidates.push(cand);
    };

    // Content Modifier header/property tables
    flowElements(model).forEach((el, i) => {
      if (el.activityType !== 'Enricher') return;
      for (const table of ['headerTable', 'propertyTable']) {
        const rows = (el.allTableAttributes && el.allTableAttributes[table] && el.allTableAttributes[table].value) || [];
        rows.forEach((row, r) => {
          const cell = row && row.Value;
          const type = row && row.Type && row.Type.value;
          const fieldName = (row && row.Name && row.Name.value) || '';
          if (!cell || !cell.value || cell.key) return;
          if (type && type !== 'constant') return;
          consider(fieldName, cell.value, (c) => ({
            id: `${i}:${table}:${r}`, stepName: el.name,
            field: table === 'headerTable' ? 'header' : 'property',
            fieldName, value: cell.value,
            suggestedName: sanitize(fieldName) || suggestName(el.name, c && c.hint, 'value'),
          }));
        });
      }
    });

    // Adapter (channel) scalar attributes
    channels(model).forEach((ch, i) => {
      const chName = valOf(ch.name) || `Adapter_${i}`;
      const aa = ch.allAttributes || {};
      for (const attr of Object.keys(aa)) {
        const cell = aa[attr];
        if (!cell || typeof cell !== 'object' || typeof cell.value !== 'string') continue;
        if (!('key' in cell) || !cell.value || cell.key) continue;
        consider(attr, cell.value, () => ({
          id: `ch:${i}:${attr}`, stepName: chName, field: 'adapter', fieldName: attr, value: cell.value,
          suggestedName: sanitize(`${chName}_${attr}`),
        }));
      }
    });

    return { candidates, externalizedCount: (model.listOfExternalizedPropertiesModel || []).length };
  }

  // Apply externalizations to a copy of the editor model; returns { model, applied }.
  function applyModel(model, selections) {
    const out = structuredClone(model);
    if (!out.listOfExternalizedPropertiesModel) out.listOfExternalizedPropertiesModel = [];
    const applied = [];
    for (const sel of selections) {
      // Adapter (channel) field
      if (sel.id.indexOf('ch:') === 0) {
        const [, ci, attr] = sel.id.split(':');
        const ch = channels(out)[+ci];
        const cell = ch && ch.allAttributes && ch.allAttributes[attr];
        if (!cell) continue;
        const value = cell.value;
        ch.allAttributes[attr] = { value, defaultValue: value, key: sel.paramName, isModified: true, dataType: 'xsd:string', description: '' };
        out.listOfExternalizedPropertiesModel.push({
          propertyObj: { key: sel.paramName, value, defaultValue: value, description: '', isModified: true, dataType: 'xsd:string' },
          listOfReferences: [{
            IType: 'DEFAULT_CHANNEL', id: ch.id, adapterType: valOf(ch.adapterType), name: valOf(ch.name),
            bindingPath: `/allAttributes/${attr}/value/0/value`, refCount: 1,
          }],
        });
        applied.push({ name: sel.paramName, value, step: valOf(ch.name), field: 'adapter' });
        continue;
      }
      // Content Modifier table cell
      const [i, table, r] = sel.id.split(':');
      const el = flowElements(out)[+i];
      const row = el && el.allTableAttributes && el.allTableAttributes[table] && el.allTableAttributes[table].value[+r];
      if (!row || !row.Value) continue;
      const cell = row.Value;
      const value = cell.value;
      cell.key = sel.paramName;
      cell.defaultValue = value;
      cell.isModified = true;
      if (cell.description == null) cell.description = '';
      if (table === 'headerTable' && cell.additionalMetadata == null) cell.additionalMetadata = {};
      out.listOfExternalizedPropertiesModel.push({
        propertyObj: { key: sel.paramName, value, defaultValue: value, description: '', isModified: true, dataType: 'xsd:string' },
        listOfReferences: [{
          IType: 'DEFAULT_FLOWSTEP', activityType: el.activityType, displayName: el.displayName || 'Content Modifier',
          id: el.id, name: el.name,
          bindingPath: `/listOfDefaultFlowElementModel/${i}/allTableAttributes/${table}/value/${r}`, refCount: 1,
        }],
        isTable: true,
      });
      applied.push({ name: sel.paramName, value, step: el.name, field: table });
    }
    return { model: out, applied };
  }

  // ======================================================================
  // Parameter Value Manager — read/write externalized-parameter VALUES (defaults)
  // ======================================================================
  // listOfReferences is a client-session artifact (often EMPTY after save/reload), so we
  // locate a parameter's field(s) by scanning for cells whose `key` === the parameter name
  // (cell.key IS persisted) — works for Content Modifier table cells and adapter attributes.
  function eachValueCell(model, fn) {
    for (const el of flowElements(model)) {
      const ta = el.allTableAttributes || {};
      for (const t of Object.keys(ta)) {
        const rows = ta[t] && ta[t].value;
        if (!Array.isArray(rows)) continue;
        for (const row of rows) if (row && row.Value && typeof row.Value === 'object') {
          fn(row.Value, { kind: 'step', name: el.name || '', detail: t === 'headerTable' ? 'header' : t === 'propertyTable' ? 'property' : t });
        }
      }
    }
    for (const ch of channels(model)) {
      const aa = ch.allAttributes || {};
      const cn = (ch.name && ch.name.value) || '';
      for (const k of Object.keys(aa)) { const c = aa[k]; if (c && typeof c === 'object' && 'key' in c) fn(c, { kind: 'adapter', name: cn, detail: k }); }
    }
  }

  function readParameters(model) {
    const where = {};
    eachValueCell(model, (cell, loc) => { if (cell.key) (where[cell.key] = where[cell.key] || []).push(loc); });
    const seen = new Set();
    const out = [];
    for (const e of (model && model.listOfExternalizedPropertiesModel) || []) {
      const po = e && e.propertyObj;
      if (!po || !po.key || seen.has(po.key)) continue;
      seen.add(po.key);
      out.push({ name: po.key, value: po.value != null ? String(po.value) : '', dataType: po.dataType || 'xsd:string', refs: where[po.key] || [] });
    }
    return out;
  }

  // Apply new default values to a copy of the model; returns { model, applied }.
  function applyParameterValues(model, values) {
    const out = structuredClone(model);
    const applied = [];
    for (const e of out.listOfExternalizedPropertiesModel || []) {
      const po = e && e.propertyObj;
      if (!po || !(po.key in values)) continue;
      const to = String(values[po.key]);
      const from = po.value != null ? String(po.value) : '';
      po.value = to; po.defaultValue = to;
      if (from !== to) applied.push({ name: po.key, from, to });
    }
    eachValueCell(out, (cell) => { if (cell.key && cell.key in values) { const v = String(values[cell.key]); cell.value = v; cell.defaultValue = v; } });
    return { model: out, applied };
  }

  // ======================================================================
  const api = { analyze, apply, classify, scanProperties, findIflowPath, analyzeModel, applyModel, readParameters, applyParameterValues };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.__CpixEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
