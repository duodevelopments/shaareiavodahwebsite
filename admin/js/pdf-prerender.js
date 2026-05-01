/**
 * Background pre-render hook — runs after page load on every admin page.
 *
 * Flow:
 *   1. Find this Sunday (Detroit time) and ask the server which of the next
 *      10 weeks have PDFs in R2.
 *   2. For each missing one: fetch resolved schedule JSON → render in browser
 *      with PdfRenderer → upload bytes to R2 via /api/admin/schedules/pdf-upload.
 *   3. Show a small unobtrusive status pill in the bottom-right while working;
 *      hide when done.
 *
 * Works sequentially (one render at a time) to keep the laptop responsive
 * and avoid hammering the upload endpoint. The whole thing yields to
 * requestIdleCallback / setTimeout so it never blocks initial paint.
 *
 * Depends on PdfRenderer (admin/js/pdf-renderer.js) being loaded first.
 */
(function () {
  if (window.__pdfPrerenderStarted) return;
  window.__pdfPrerenderStarted = true;

  const PILL_ID = '__pdf_prerender_pill__';

  function ensurePill() {
    let el = document.getElementById(PILL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PILL_ID;
    el.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px',
      'padding:8px 14px', 'border-radius:999px',
      'background:rgba(35,33,64,0.92)', 'color:#fff',
      'font:13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif',
      'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
      'z-index:99999', 'opacity:0', 'transition:opacity 200ms ease',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function showPill(text) {
    const el = ensurePill();
    el.textContent = text;
    el.style.opacity = '1';
  }

  function hidePill(delayMs = 1500) {
    const el = document.getElementById(PILL_ID);
    if (!el) return;
    setTimeout(() => { el.style.opacity = '0'; }, delayMs);
  }

  function showError(text) {
    const el = ensurePill();
    el.textContent = text;
    el.style.background = 'rgba(170,40,40,0.95)';
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 8000);
  }

  // Persistent banner at the top of the page — shown when the upcoming
  // Shabbos's PDF is missing and re-render attempts failed. This is the only
  // case the user actively needs to do something about.
  function showThisWeekBanner(span, errorText) {
    const BANNER_ID = '__pdf_prerender_banner__';
    if (document.getElementById(BANNER_ID)) return;
    const el = document.createElement('div');
    el.id = BANNER_ID;
    el.style.cssText = [
      'position:sticky', 'top:0',
      'background:#fde2c0', 'color:#5a3300',
      'border-bottom:1px solid #d6a76b',
      'padding:10px 16px',
      'font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
      'z-index:99998', 'display:flex', 'align-items:center', 'gap:12px',
    ].join(';');
    const onWeekPage = location.pathname.startsWith('/admin/week');
    const reviewUrl = `/admin/week?sunday=${getThisSunday()}`;
    el.innerHTML = `
      <strong>⚠ This week's printable PDF isn't ready.</strong>
      <span>The Friday email won't include it. ${onWeekPage ? 'Re-render below.' : `<a href="${reviewUrl}" style="color:#5a3300;text-decoration:underline">Open the week to fix →</a>`}</span>
      <span style="margin-left:auto;font-size:12px;opacity:0.7">${escapeHtml(errorText || '')}</span>
    `;
    document.body.insertBefore(el, document.body.firstChild);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function getThisSunday() { return thisWeekSundayISO(); }

  function detroitToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Detroit',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(new Date());
    const y = +parts.find((p) => p.type === 'year').value;
    const m = +parts.find((p) => p.type === 'month').value;
    const d = +parts.find((p) => p.type === 'day').value;
    const wk = parts.find((p) => p.type === 'weekday').value;
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { y, m, d, dow: dowMap[wk] };
  }

  function thisWeekSundayISO() {
    const t = detroitToday();
    const utc = new Date(Date.UTC(t.y, t.m - 1, t.d - t.dow, 12));
    return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  async function uploadPdf(cacheKey, bytes) {
    const res = await fetch(`/api/admin/schedules/pdf-upload?key=${encodeURIComponent(cacheKey)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: bytes,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`upload ${cacheKey}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }

  async function renderOne(span, assets) {
    const res = await fetch(
      `/api/admin/schedules/resolved?startDate=${span.startDate}&endDate=${span.endDate}`
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`resolved ${span.startDate}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.cacheKey !== span.cacheKey) {
      // Schedule changed between status check and render — use the fresh key.
      span.cacheKey = data.cacheKey;
    }
    const bytes = await window.PdfRenderer.render({
      schedule: data.schedule,
      announcements: data.announcements,
      layout: data.layout,
      ...assets,
    });
    await uploadPdf(span.cacheKey, bytes);
  }

  async function run() {
    if (!window.PdfRenderer) {
      console.warn('[pdf-prerender] PdfRenderer not loaded; skipping');
      return;
    }
    if (!window.PDFLib || !window.fontkit) {
      console.warn('[pdf-prerender] pdf-lib / fontkit not loaded; skipping');
      return;
    }

    let spans;
    try {
      const sunday = thisWeekSundayISO();
      const res = await fetch(`/api/admin/schedules/cache-status?sunday=${sunday}&weeks=10`);
      if (!res.ok) throw new Error(`cache-status: HTTP ${res.status}`);
      const data = await res.json();
      spans = data.spans || [];
    } catch (err) {
      console.warn('[pdf-prerender] cache-status failed:', err);
      return;
    }

    const missing = spans.filter((s) => !s.exists);
    const thisWeekSpan = spans[0]; // closest upcoming Shabbos
    const thisWeekWasMissing = thisWeekSpan && !thisWeekSpan.exists;

    if (missing.length === 0) return; // All warm — nothing to do.

    showPill(`Pre-rendering 0/${missing.length}…`);

    let assets;
    try {
      assets = await window.PdfRenderer.loadAssets();
    } catch (err) {
      if (thisWeekWasMissing) showThisWeekBanner(thisWeekSpan, 'Could not load fonts/logos');
      showError('Pre-render: asset load failed');
      console.error('[pdf-prerender] loadAssets:', err);
      return;
    }

    let done = 0;
    let failed = 0;
    let thisWeekError = null;
    for (const span of missing) {
      try {
        await renderOne(span, assets);
        done++;
      } catch (err) {
        failed++;
        if (span === thisWeekSpan) thisWeekError = err?.message || String(err);
        console.error('[pdf-prerender] render failed for', span.startDate, err);
      }
      showPill(
        failed > 0
          ? `Pre-rendering ${done}/${missing.length} (${failed} failed)…`
          : `Pre-rendering ${done}/${missing.length}…`
      );
      await new Promise((r) => setTimeout(r, 50));
    }

    // Banner only fires for the imminent Shabbos. Other weeks failing is
    // background noise — the pill (and the console) covers them.
    if (thisWeekWasMissing && thisWeekError) {
      showThisWeekBanner(thisWeekSpan, thisWeekError);
    }

    if (failed === 0) {
      showPill(`Pre-rendered ${done} weeks ✓`);
      hidePill();
    } else {
      showError(`Pre-render: ${failed} of ${missing.length} failed (see console)`);
    }
  }

  function start() {
    const fire = () => { run().catch((e) => console.error('[pdf-prerender]', e)); };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(fire, { timeout: 3000 });
    } else {
      setTimeout(fire, 800);
    }
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
