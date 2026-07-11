// pvm.js — Parameter Value Manager engine (dependency-free, browser + Node).
//
// Manages externalized-parameter VALUES across environments. This module is the
// deterministic core: parse/serialize "environment profiles", diff value sets, validate a
// profile against an iFlow's parameters, and plan the set of writes to apply. The transport
// (OData /Configurations PUT, or the session model write) lives in the plugin/API layer.
//
// Canonical profile shape:
//   { version: 1, iflow: string|null, environments: string[],
//     parameters: { [name]: { [env]: string } } }

(function (root) {
  'use strict';

  // ---- CSV helpers (minimal, quote-aware) ----------------------------------
  function parseCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  const csvCell = (v) => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));

  // ---- parse ---------------------------------------------------------------
  function normalize(obj) {
    // Accept: canonical; single-env {environment,parameters:{name:val}}; flat {name:val}.
    if (obj && obj.parameters && obj.environments) {
      return { version: 1, iflow: obj.iflow || null, environments: obj.environments.slice(), parameters: obj.parameters };
    }
    if (obj && obj.parameters) {
      const env = obj.environment || 'value';
      const parameters = {};
      for (const [k, v] of Object.entries(obj.parameters)) parameters[k] = { [env]: String(v) };
      return { version: 1, iflow: obj.iflow || null, environments: [env], parameters };
    }
    // flat map of name->value
    const parameters = {};
    for (const [k, v] of Object.entries(obj || {})) parameters[k] = { value: String(v) };
    return { version: 1, iflow: null, environments: ['value'], parameters };
  }

  function parseProfile(text, format) {
    const t = String(text || '').trim();
    const fmt = format || (t[0] === '{' ? 'json' : 'csv');
    if (fmt === 'json') return normalize(JSON.parse(t));
    // csv: header = Name,<env1>,<env2>,...
    const rows = t.split(/\r?\n/).filter((r) => r.trim() !== '');
    const header = parseCsvLine(rows[0]);
    const environments = header.slice(1).map((s) => s.trim());
    const parameters = {};
    for (let i = 1; i < rows.length; i++) {
      const cells = parseCsvLine(rows[i]);
      const name = (cells[0] || '').trim();
      if (!name) continue;
      const rec = {};
      environments.forEach((env, j) => { const v = cells[j + 1]; if (v !== undefined && v !== '') rec[env] = v; });
      parameters[name] = rec;
    }
    return { version: 1, iflow: null, environments, parameters };
  }

  // ---- serialize -----------------------------------------------------------
  function serializeProfile(profile, format) {
    if ((format || 'json') === 'json') return JSON.stringify(profile, null, 2);
    const envs = profile.environments;
    const lines = ['Name,' + envs.map(csvCell).join(',')];
    for (const [name, rec] of Object.entries(profile.parameters)) {
      lines.push([csvCell(name), ...envs.map((e) => csvCell(rec[e] != null ? rec[e] : ''))].join(','));
    }
    return lines.join('\n') + '\n';
  }

  // ---- queries -------------------------------------------------------------
  function valuesForEnv(profile, env) {
    const out = {};
    for (const [name, rec] of Object.entries(profile.parameters)) if (rec[env] !== undefined) out[name] = rec[env];
    return out;
  }

  // diff two flat {name:value} maps
  function diffValues(current, target) {
    const changed = [], added = [], removed = [];
    for (const [name, to] of Object.entries(target)) {
      if (!(name in current)) added.push({ name, to });
      else if (current[name] !== to) changed.push({ name, from: current[name], to });
    }
    for (const name of Object.keys(current)) if (!(name in target)) removed.push({ name, from: current[name] });
    return { changed, added, removed };
  }

  // ---- validate a profile against the iFlow's params for one environment ----
  // iflow = { params: string[], defaults: {name:val} }
  function validate(iflow, profile, env) {
    const vals = valuesForEnv(profile, env);
    const params = iflow.params || [];
    const defaults = iflow.defaults || {};
    const missing = params.filter((p) => vals[p] === undefined);
    const stale = Object.keys(vals).filter((p) => !params.includes(p));
    const empty = params.filter((p) => vals[p] === '');
    const atDefault = params.filter((p) => vals[p] !== undefined && vals[p] === defaults[p]);
    return { missing, stale, empty, atDefault, ok: missing.length === 0 && stale.length === 0 && empty.length === 0 };
  }

  // ---- plan the writes needed to reach targetValues -------------------------
  // state = { params: string[], defaults:{}, configured:{} }  (configured = current live values)
  function plan(state, targetValues) {
    const params = state.params || [];
    const defaults = state.defaults || {};
    const configured = state.configured || {};
    const sets = [], unchanged = [], unknown = [];
    for (const [name, to] of Object.entries(targetValues)) {
      if (!params.includes(name)) { unknown.push(name); continue; }
      const current = configured[name] !== undefined ? configured[name] : defaults[name];
      if (current === to) unchanged.push(name);
      else sets.push({ name, from: current, to, atDefault: to === defaults[name] });
    }
    return { sets, unchanged, unknown, atDefaultAfter: sets.filter((s) => s.atDefault).map((s) => s.name) };
  }

  const api = { parseProfile, serializeProfile, valuesForEnv, diffValues, validate, plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.__CpixPVM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
