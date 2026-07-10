/*
 * Tenant diagnostic v3 — READ-ONLY. Paste into the DevTools console on the iFlow editor page.
 * Captures the 405 Allow header, tries the artifact hash id, and checks whether the public
 * OData /api/v1 works with your session. GET/OPTIONS only. Nothing leaves the browser.
 */
(async () => {
  const origin = location.origin;
  const root = `${origin}/api/1.0`;
  const odata = `${origin}/api/v1`;
  const src = decodeURIComponent(location.hash + ' ' + location.href);
  const A = (src.match(/integrationflows?\/([^/?#\s]+)/i) || src.match(/artifacts\/([^/?#\s]+)/i) || [])[1];
  const pkg = (src.match(/contentpackage\/([^/?#\s]+)/i) || src.match(/ContentPackages?\/([^/?#\s]+)/i) || [])[1];
  const out = { artifactId: A, pkg };

  // resolve workspace hash + artifact hash
  let wsId = pkg;
  try {
    const ws = JSON.parse(await (await fetch(`${root}/workspace/`, { headers: { Accept: 'application/json' }, credentials: 'include' })).text());
    const m = ws.find((x) => Object.values(x).includes(pkg));
    if (m) wsId = m.id;
  } catch (e) { out.wsErr = String(e); }
  out.wsId = wsId;
  try {
    const arts = JSON.parse(await (await fetch(`${root}/workspace/${wsId}/artifacts/`, { headers: { Accept: 'application/json' }, credentials: 'include' })).text());
    const e = arts.find((x) => x.name === A || x.tooltip === A) || arts.find((x) => (x.name || '').includes(A) || (x.tooltip || '').includes(A));
    out.artifact = e ? { id: e.id, entityID: e.entityID, name: e.name, tooltip: e.tooltip, semanticVersion: e.semanticVersion } : 'NOT FOUND';
    out.artHash = e && (e.entityID || e.id);
  } catch (e) { out.artErr = String(e); }

  const probe = async (method, url, headers) => {
    try {
      const r = await fetch(url, { method, headers, credentials: 'include' });
      const t = await r.text();
      return { method, status: r.status, allow: r.headers.get('allow'), ct: r.headers.get('content-type'), body: t.slice(0, 220), url };
    } catch (e) { return { method, url, error: String(e) }; }
  };

  // internal /api/1.0
  out.internal = [];
  out.internal.push(await probe('OPTIONS', `${root}/workspace/${wsId}/artifacts/${A}/entities/${A}/iflows/${A}?webdav=DOWNLOAD`));
  out.internal.push(await probe('GET', `${root}/workspace/${wsId}/artifacts/${A}/entities/${A}/iflows/${A}`)); // no webdav → JSON model?
  if (out.artHash) out.internal.push(await probe('GET', `${root}/workspace/${wsId}/artifacts/${out.artHash}/entities/${out.artHash}/iflows/${out.artHash}?webdav=DOWNLOAD`));

  // public OData /api/v1 (with session cookies)
  out.odata = [];
  out.odata.push(await probe('GET', `${odata}/IntegrationDesigntimeArtifacts?$top=2&$format=json`, { Accept: 'application/json' }));
  out.odata.push(await probe('GET', `${odata}/IntegrationDesigntimeArtifacts(Id='${A}',Version='active')?$format=json`, { Accept: 'application/json' }));

  console.log('RESULT3', out);
  window.__cpixDiag3 = out;
  return out;
})();
