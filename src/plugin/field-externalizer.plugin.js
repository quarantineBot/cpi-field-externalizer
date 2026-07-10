/*
 * iFlow Field Externalizer — content script.
 *
 * Runs as a standalone Chrome extension (bundled with vendor/jszip.min.js + the engine), and
 * ALSO works as a plugin for a compatible CPI browser-helper extension when one is present
 * (registers on its `pluginList` and reuses its showToast/workingIndicator/cpiData/JSZip).
 * Every host global is optional and guarded, so neither mode depends on the other.
 *
 * Two ways to externalize the current iFlow's hardcoded fields (URLs, hosts, credentials,
 * ports, paths) into {{parameters}}, with a review step:
 *
 *   • Live (in place)  — reads the open iFlow's editor model via the same-origin design API
 *                        (your session), rewrites Content Modifier + adapter values to
 *                        externalized parameters, saves back to the SAME artifact, and
 *                        reloads the editor. No export/import.
 *   • Exported zip     — offline path: load an exported .iflw zip, review, download the
 *                        externalized zip.
 *
 * Requires the engine (src/engine/engine.js) loaded first (exposes __CpixEngine).
 * Self-contained; no build step, no external references.
 */
(function () {
  'use strict';

  const PLUGIN_ID = 'iflowFieldExternalizer';

  const host = {
    hasFramework: typeof pluginList !== 'undefined',
    toast(m, d, t) { if (typeof showToast === 'function') showToast(m, d || '', t || 'info'); },
    working(on) { if (typeof workingIndicator === 'function') workingIndicator(!!on); },
    zip() { return (typeof JSZip !== 'undefined' && JSZip) || (typeof window !== 'undefined' && window.JSZip) || null; },
    cpiData() { return typeof cpiData !== 'undefined' ? cpiData : null; },
  };
  const engine = () => (typeof window !== 'undefined' && window.__CpixEngine) || (typeof globalThis !== 'undefined' && globalThis.__CpixEngine) || null;

  // ---- context -------------------------------------------------------------
  function detectCtx(cpi) {
    const cd = cpi || {};
    const src = decodeURIComponent(location.hash + ' ' + location.href);
    const idM = src.match(/integrationflows?\/([^/?#\s]+)/i) || src.match(/artifacts\/([^/?#\s]+)/i);
    const pkgM = src.match(/contentpackage\/([^/?#\s]+)/i) || src.match(/ContentPackages?\/([^/?#\s]+)/i);
    const ext = cd.urlExtension != null ? cd.urlExtension : (location.pathname.includes('/itspaces/') ? 'itspaces' : '');
    const norm = String(ext || '').replace(/^\/+|\/+$/g, '');
    return {
      origin: location.origin,
      apiRoot: `${location.origin}/${norm ? norm + '/' : ''}api/1.0`,
      iflowName: cd.integrationFlowId || (idM && idM[1]) || '',
      pkg: cd.packageId || (pkgM && pkgM[1]) || '',
    };
  }

  // ---- design-time API (same-origin session) -------------------------------
  const j = (r) => r.json();
  async function getCsrf(apiRoot) {
    const r = await fetch(`${apiRoot}/user`, { headers: { 'X-CSRF-Token': 'Fetch' }, credentials: 'include' });
    return r.headers.get('x-csrf-token');
  }
  async function resolveIds(ctx) {
    if (!ctx.pkg || !ctx.iflowName) throw new Error('Could not determine the package/iFlow from the URL.');
    const ws = await fetch(`${ctx.apiRoot}/workspace/`, { headers: { Accept: 'application/json' }, credentials: 'include' }).then(j);
    const wsHash = (ws.find((x) => x.technicalName === ctx.pkg) || ws.find((x) => Object.values(x).includes(ctx.pkg)) || {}).id;
    if (!wsHash) throw new Error(`Package "${ctx.pkg}" not found.`);
    const arts = await fetch(`${ctx.apiRoot}/workspace/${wsHash}/artifacts/`, { headers: { Accept: 'application/json' }, credentials: 'include' }).then(j);
    const art = arts.find((x) => x.name === ctx.iflowName || x.tooltip === ctx.iflowName) || arts.find((x) => (x.name || '').includes(ctx.iflowName));
    if (!art) throw new Error(`iFlow "${ctx.iflowName}" not found in package "${ctx.pkg}".`);
    return { wsHash, artHash: art.entityID || art.id, iflowName: ctx.iflowName };
  }
  function iflowUrl(apiRoot, ids) {
    const h = encodeURIComponent(ids.artHash);
    return `${apiRoot}/workspace/${encodeURIComponent(ids.wsHash)}/artifacts/${h}/entities/${h}/iflows/${encodeURIComponent(ids.iflowName)}`;
  }
  async function getModel(apiRoot, ids) {
    const r = await fetch(iflowUrl(apiRoot, ids), { headers: { Accept: 'application/json' }, credentials: 'include' });
    if (!r.ok) throw new Error(`Read model failed (${r.status}).`);
    return r.json();
  }
  async function putModel(apiRoot, ids, model, csrf) {
    const r = await fetch(iflowUrl(apiRoot, ids), {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf || '' },
      body: JSON.stringify(model),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Save (PUT) failed (${r.status}). ${t.slice(0, 160)}`); }
  }
  async function deleteDraft(apiRoot, ids, csrf) {
    const h = encodeURIComponent(ids.artHash);
    const url = `${apiRoot}/workspace/${encodeURIComponent(ids.wsHash)}/artifacts/${h}/entities/${h}/drafts/${encodeURIComponent(ids.iflowName)}?type=iflow`;
    try { await fetch(url, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': csrf || '' } }); } catch (e) { /* best effort */ }
  }

  // ---- zip <-> files map (host JSZip; exported-zip path) -------------------
  async function zipToFiles(arrayBuffer) {
    const JSZ = host.zip();
    if (!JSZ) throw new Error('JSZip is not available from the host extension.');
    const zip = await JSZ.loadAsync(arrayBuffer);
    const strings = {};
    for (const p of Object.keys(zip.files)) if (!zip.files[p].dir) strings[p] = await zip.files[p].async('string');
    return { zip, strings };
  }
  async function filesToBlob(zip, newFiles, originalStrings) {
    for (const [p, content] of Object.entries(newFiles)) if (content !== originalStrings[p]) zip.file(p, content);
    return zip.generateAsync({ type: 'blob' });
  }

  // ---- DOM helpers ---------------------------------------------------------
  const el = (tag, props, style) => { const n = Object.assign(document.createElement(tag), props || {}); if (style) Object.assign(n.style, style); return n; };
  const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  function downloadBlob(name, blob) { const a = el('a', { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  function downloadText(name, text) { downloadBlob(name, new Blob([text], { type: 'application/json' })); }

  function buildShell() {
    const back = el('div', {}, { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.45)', zIndex: '2147483647', font: '13px Arial, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' });
    const box = el('div', {}, { background: '#fff', color: '#222', width: 'min(960px, 95vw)', maxHeight: '88vh', borderRadius: '8px', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 10px 40px rgba(0,0,0,.4)' });
    const head = el('div', {}, { padding: '14px 18px', background: '#0a6ed1', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
    head.appendChild(el('strong', { textContent: 'iFlow Field Externalizer' }));
    const x = el('button', { textContent: '✕', title: 'Close' }, { background: 'transparent', border: 'none', color: '#fff', fontSize: '16px', cursor: 'pointer' });
    x.onclick = () => back.remove();
    head.appendChild(x);
    const body = el('div', {}, { padding: '16px 18px', overflow: 'auto' });
    const foot = el('div', {}, { padding: '12px 18px', borderTop: '1px solid #eee', display: 'flex', gap: '10px', justifyContent: 'flex-end' });
    box.append(head, body, foot); back.appendChild(box);
    return { back, body, foot };
  }

  // ---- generic review table ------------------------------------------------
  // candidates: [{ id, suggestedName, value, reason, confidence, ...+ describe() cols }]
  function renderReview(ui, headline, candidates, describe, onApply, extraControl) {
    const { back, body, foot } = ui;
    body.innerHTML = ''; foot.innerHTML = '';
    body.appendChild(el('p', { textContent: headline }));
    if (extraControl) body.appendChild(extraControl);
    if (!candidates.length) {
      body.appendChild(el('p', { textContent: 'No externalization candidates found.' }, { color: '#777' }));
      const done = el('button', { textContent: 'Close' }, { padding: '8px 14px', cursor: 'pointer' }); done.onclick = () => back.remove(); foot.appendChild(done); return;
    }
    const table = el('table', {}, { width: '100%', borderCollapse: 'collapse' });
    table.innerHTML = '<thead><tr>' + ['On', 'Parameter name', 'Where', 'Value', 'Why'].map((h) => `<th style="text-align:left;padding:6px;border-bottom:2px solid #ddd">${h}</th>`).join('') + '</tr></thead>';
    const tb = el('tbody');
    const cell = (h) => el('td', { innerHTML: h }, { padding: '6px', borderBottom: '1px solid #eee', verticalAlign: 'top' });
    const rows = candidates.map((c) => {
      const tr = el('tr');
      const cb = el('input', { type: 'checkbox', checked: c.confidence === 'high' });
      const name = el('input', { type: 'text', value: c.suggestedName }, { width: '210px', font: '12px monospace' });
      const c1 = cell(''); c1.appendChild(cb); const c2 = cell(''); c2.appendChild(name);
      tr.append(c1, c2, cell(describe(c)), cell(`<code style="font-size:11px">${esc(c.value).slice(0, 90)}</code>`), cell(`<span style="color:#0a6ed1">${esc(c.reason)}</span>`));
      tb.appendChild(tr); return { c, cb, name };
    });
    table.appendChild(tb); body.appendChild(table);
    const apply = el('button', { textContent: 'Apply' }, { padding: '8px 14px', background: '#107e3e', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer' });
    apply.onclick = () => {
      const sel = rows.filter((r) => r.cb.checked).map((r) => ({ id: r.c.id, paramName: r.name.value.trim() }));
      if (!sel.length) return alert('Select at least one field.');
      if (sel.some((s) => !s.paramName)) return alert('Every selected field needs a parameter name.');
      onApply(sel);
    };
    foot.appendChild(apply);
  }

  // ---- live (in-place) flow ------------------------------------------------
  async function runLive(ui, ctx) {
    host.working(true);
    let ids, model;
    try {
      ids = await resolveIds(ctx);
      model = await getModel(ctx.apiRoot, ids);
    } finally { host.working(false); }

    const describe = (c) => `<span style="color:#555">${esc(c.stepName || '—')}</span> <span style="color:#999">(${c.recommended ? 'detected' : 'manual'})</span><br><code style="font-size:11px">${esc(c.field)}: ${esc(c.fieldName)}</code>`;

    const onApply = async (sel) => {
      const { model: next, applied } = engine().applyModel(model, sel);
      downloadText(`${ids.iflowName}.model-backup.json`, JSON.stringify(model, null, 2)); // safety backup
      if (!confirm(`Save ${applied.length} externalized parameter(s) to the live iFlow "${ids.iflowName}" and reload the editor?\n\nA backup of the current model was just downloaded. Make sure you've saved any other pending edits first.`)) return;
      host.working(true);
      try {
        const csrf = await getCsrf(ctx.apiRoot);
        await putModel(ctx.apiRoot, ids, next, csrf);
        await deleteDraft(ctx.apiRoot, ids, csrf);
        host.toast(`Externalized ${applied.length} field(s)`, 'Saved to the iFlow. Reloading the editor…', 'success');
        ui.back.remove();
        setTimeout(() => location.reload(), 900);
      } catch (e) {
        host.working(false);
        alert('Save failed: ' + e.message + '\n\nYour iFlow was not changed. Restore from the downloaded backup if needed.');
      }
    };

    const render = (includeAll) => {
      const { candidates } = engine().analyzeModel(model, { includeAll });
      const ctrl = el('label', {}, { display: 'block', margin: '4px 0 10px', color: '#555', cursor: 'pointer' });
      const cbAll = el('input', { type: 'checkbox', checked: includeAll }, { marginRight: '6px', verticalAlign: 'middle' });
      cbAll.onchange = () => render(cbAll.checked);
      ctrl.append(cbAll, document.createTextNode('Show all constant fields (not just auto-detected)'));
      const headline = includeAll
        ? `${ids.iflowName} — ${candidates.length} constant Content Modifier field(s). Detected ones are pre-ticked; tick any others.`
        : `${ids.iflowName} — ${candidates.length} auto-detected field(s). Enable “show all” to externalize others too.`;
      renderReview(ui, headline, candidates, describe, onApply, ctrl);
    };
    render(false);
  }

  // ---- exported-zip flow ---------------------------------------------------
  async function runZip(ui, arrayBuffer, sourceName) {
    const { zip, strings } = await zipToFiles(arrayBuffer);
    const analysis = engine().analyze(strings);
    const describe = (c) => `<span style="color:#555">${esc(c.stepName || '—')}</span><br><code style="font-size:11px">${esc(c.key)}</code>`;
    renderReview(ui, `${analysis.iflowPath.split('/').pop()} — ${analysis.candidates.length} candidate(s).`, analysis.candidates, describe, async (sel) => {
      const { files, applied } = engine().apply(strings, sel);
      const blob = await filesToBlob(zip, files, strings);
      downloadBlob(`${sourceName.replace(/\.zip$/i, '')}.externalized.zip`, blob);
      ui.back.remove();
      host.toast(`Externalized ${applied.length} field(s)`, 'Downloaded the externalized zip.', 'success');
    });
  }

  // ---- home view -----------------------------------------------------------
  function renderHome(ui, ctx) {
    const { body, foot } = ui;
    body.innerHTML = ''; foot.innerHTML = '';

    const live = el('div', {}, { marginBottom: '18px' });
    live.appendChild(el('div', { innerHTML: '<strong>Externalize the open iFlow (live)</strong> — reads it via your session, rewrites Content Modifier fields, saves in place, reloads.' }));
    const liveBtn = el('button', { textContent: ctx.iflowName ? `Externalize "${ctx.iflowName}"` : 'Open an iFlow in the editor first', disabled: !ctx.iflowName }, { marginTop: '6px', padding: '8px 14px', background: '#0a6ed1', color: '#fff', border: 'none', borderRadius: '5px', cursor: ctx.iflowName ? 'pointer' : 'not-allowed' });
    const status = el('p', {}, { color: '#b00', minHeight: '16px' });
    liveBtn.onclick = async () => { status.textContent = ''; try { await runLive(ui, ctx); } catch (e) { status.style.color = '#b00'; status.textContent = e.message; host.working(false); } };
    live.append(liveBtn, status);
    body.appendChild(live);

    const zipWrap = el('div');
    zipWrap.appendChild(el('div', { innerHTML: '<strong>Or work on an exported zip</strong> — load, review, download the externalized zip:' }));
    const file = el('input', { type: 'file', accept: '.zip' }, { marginTop: '6px' });
    file.onchange = async () => { const f = file.files[0]; if (f) { try { await runZip(ui, await f.arrayBuffer(), f.name); } catch (e) { alert(e.message); } } };
    zipWrap.appendChild(file);
    body.appendChild(zipWrap);
  }

  function openDialog(cpi) {
    if (!engine()) { alert('Externalizer engine not loaded. Ensure engine.js is loaded before this plugin.'); return; }
    const ui = buildShell();
    document.body.appendChild(ui.back);
    renderHome(ui, detectCtx(cpi));
  }

  // ---- launcher ------------------------------------------------------------
  // Only show the floating button on an iFlow editor page, and keep it in sync as the user
  // navigates the SAPUI5 single-page app (which fires no reliable route event).
  function isIflowEditor() {
    const s = location.hash + ' ' + location.href;
    return /integrationflows?\/[^/?#\s]+/i.test(s) || /artifacts\/[^/?#\s]+/i.test(s);
  }
  let fabEl = null;
  function syncLauncher() {
    if (!document.body) return;
    const present = document.getElementById('iflowFieldExt-fab');
    if (isIflowEditor()) {
      if (present) return;
      if (!fabEl) {
        fabEl = el('button', { id: 'iflowFieldExt-fab', type: 'button', textContent: '⧉ Externalize fields' },
          { position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483646', padding: '10px 14px', background: '#0a6ed1', color: '#fff', border: 'none', borderRadius: '6px', font: '600 13px Arial, sans-serif', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,.35)' });
        fabEl.onclick = () => openDialog(host.cpiData());
      }
      document.body.appendChild(fabEl);
    } else if (present) {
      present.remove();
    }
  }
  function startLauncher() {
    syncLauncher();
    window.addEventListener('hashchange', syncLauncher);
    window.addEventListener('popstate', syncLauncher);
    setInterval(syncLauncher, 1500);
  }

  // Register with a host CPI-helper framework if one is present (optional, dual-use).
  if (host.hasFramework) {
    try {
      pluginList.push({
        metadataVersion: '1.0.0', id: PLUGIN_ID, name: 'iFlow Field Externalizer', version: '1.0.0',
        description: 'Externalize hardcoded Content Modifier and adapter fields (URLs, hosts, credentials, location IDs, ports, paths) to {{parameters}} in place, with a review step.',
        settings: {},
        messageSidebarContent: { onRender: (cpi) => { const b = el('button', { textContent: '⧉ Externalize iFlow fields' }, { padding: '6px 10px', background: '#0a6ed1', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer', font: '600 12px Arial, sans-serif' }); b.onclick = () => openDialog(cpi || host.cpiData()); return b; } },
      });
    } catch (e) { /* non-fatal */ }
  }
  startLauncher();
})();
