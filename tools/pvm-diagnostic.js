/*
 * PVM endpoint diagnostic — READ-ONLY. Paste into the DevTools console with the iFlow open.
 * Finds how this tenant exposes externalized-parameter CONFIGURED values, so the Parameter
 * Value Manager can read/write them. Tries the public OData /Configurations and likely
 * internal endpoints. GET only. Nothing leaves the browser.
 */
(async () => {
  const origin = location.origin, root = `${origin}/api/1.0`, odata = `${origin}/api/v1`;
  const src = decodeURIComponent(location.hash + ' ' + location.href);
  const A = (src.match(/integrationflows?\/([^/?#\s]+)/i) || src.match(/artifacts\/([^/?#\s]+)/i) || [])[1];
  const pkg = (src.match(/contentpackage\/([^/?#\s]+)/i) || [])[1];
  let wsId = pkg, h = A;
  try {
    const ws = await (await fetch(`${root}/workspace/`, { headers: { Accept: 'application/json' }, credentials: 'include' })).json();
    const wm = ws.find((x) => x.technicalName === pkg) || ws.find((x) => Object.values(x).includes(pkg)); if (wm) wsId = wm.id;
    const arts = await (await fetch(`${root}/workspace/${wsId}/artifacts/`, { headers: { Accept: 'application/json' }, credentials: 'include' })).json();
    const am = arts.find((x) => x.name === A || x.tooltip === A); if (am) h = am.entityID || am.id;
  } catch (e) { /* ignore */ }

  const probe = async (label, url, headers) => {
    try {
      const r = await fetch(url, { headers, credentials: 'include' });
      const t = await r.text();
      return { label, status: r.status, ct: r.headers.get('content-type'), body: t.slice(0, 260), url };
    } catch (e) { return { label, url, error: String(e) }; }
  };

  const out = { artifactId: A, wsId, artHash: h, probes: [] };
  const J = { Accept: 'application/json' };
  // documented public OData
  out.probes.push(await probe('odata /Configurations', `${odata}/IntegrationDesigntimeArtifacts(Id='${A}',Version='active')/Configurations?$format=json`, J));
  // candidate internal endpoints (guesses — the real one is confirmed via the capture below)
  out.probes.push(await probe('internal configurations', `${root}/workspace/${wsId}/artifacts/${h}/entities/${h}/configurations`, J));
  out.probes.push(await probe('internal externalizedparameters', `${root}/workspace/${wsId}/artifacts/${h}/entities/${h}/externalizedparameters`, J));

  console.log('PVM-DIAG', out);
  window.__pvmDiag = out;
  console.log('%cIf none return the parameter list with values, capture the real one:', 'font-weight:bold');
  console.log('1) Open the iFlow\'s Configure / Externalized Parameters screen. 2) Network tab, clear, Preserve log. 3) Change a value and Save. 4) Send the PUT/POST request (method + URL + request body — no cookies).');
  return out;
})();
