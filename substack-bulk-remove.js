// ============================================================================
// Substack Bulk Subscriber Remover
// https://github.com/alexwbend/substack-bulk-unsubscribe
//
// What it does
//   Removes a list of subscribers from your Substack publication in seconds,
//   by calling the same DELETE /api/v1/subscriber/<email> endpoint the
//   Substack admin UI uses under the hood.
//
// How to use
//   1. Open your publication's subscribers page in your browser (you must be
//      signed in as the publication owner). The URL looks like:
//        https://YOUR_PUBLICATION.substack.com/publish/subscribers
//   2. Open DevTools (Cmd+Option+I on Mac, Ctrl+Shift+I on Windows/Linux).
//   3. Switch to the Console tab.
//   4. Paste this entire file and press Enter.
//   5. A panel appears in the top-right. Click "Choose file" and pick a CSV
//      or TXT file containing the emails you want to remove (one per line,
//      OR a CSV with an "email" column — the script auto-detects).
//   6. Review the preview, then click "Start removal".
//   7. Watch the progress counter. Most lists finish in under 15 minutes.
//
// Resume / stop
//   - Progress is saved in localStorage. If you close the tab or refresh,
//     re-paste the script and re-upload the same file to resume.
//   - To stop mid-run: type   window.__STOP_REMOVER = true   in the console.
//
// Caveats
//   - This uses an internal Substack API endpoint. It works as of this
//     writing but Substack could change it at any time without notice.
//   - Use at your own risk. Removals are irreversible (subscribers would
//     have to re-sign-up themselves). Always test with a small file first.
//   - Don't run multiple instances in parallel against the same publication.
//
// MIT License — see LICENSE
// ============================================================================
(() => {
  if (window.__SUBSTACK_REMOVER_INSTALLED) {
    console.warn('Substack remover already running. Reload the page first if you want a fresh instance.');
    return;
  }
  window.__SUBSTACK_REMOVER_INSTALLED = true;

  const PROGRESS_KEY = 'substack_bulk_remover_progress';
  const CONCURRENCY = 4;
  const DELAY_PER_REQ_MS = 80;
  const RETRY_DELAY_MS = 2000;
  const MAX_RETRIES = 4;

  // ---------- UI ----------
  const panel = document.createElement('div');
  panel.style.cssText = `
    position:fixed;top:16px;right:16px;width:340px;background:#111;color:#fff;
    padding:14px 16px;border-radius:10px;font:13px/1.4 ui-monospace,Menlo,monospace;
    z-index:2147483647;box-shadow:0 6px 28px rgba(0,0,0,0.4);
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <b style="font-size:14px;">Substack Bulk Remover</b>
      <span id="sbr-close" style="cursor:pointer;opacity:0.6;font-size:18px;line-height:1;">×</span>
    </div>
    <div id="sbr-step1">
      <p style="margin:6px 0 10px;opacity:0.85;">Upload a CSV or TXT with the emails to remove. One per line, or a CSV with an "email" column.</p>
      <input id="sbr-file" type="file" accept=".csv,.txt,text/csv,text/plain" style="width:100%;margin-bottom:8px;color:#fff;" />
      <div id="sbr-preview" style="font-size:12px;opacity:0.8;margin-top:6px;"></div>
    </div>
    <div id="sbr-step2" style="display:none;">
      <div id="sbr-progress" style="margin:6px 0;"></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button id="sbr-start" style="flex:1;padding:8px;border:0;border-radius:6px;background:#22c55e;color:#fff;font-weight:600;cursor:pointer;">Start removal</button>
        <button id="sbr-stop" style="padding:8px 12px;border:0;border-radius:6px;background:#ef4444;color:#fff;font-weight:600;cursor:pointer;display:none;">Stop</button>
      </div>
      <div id="sbr-results" style="margin-top:10px;font-size:12px;opacity:0.85;"></div>
    </div>
  `;
  document.body.appendChild(panel);
  document.getElementById('sbr-close').onclick = () => {
    panel.remove();
    window.__SUBSTACK_REMOVER_INSTALLED = false;
  };

  const $ = (id) => document.getElementById(id);
  const setProgress = (html) => $('sbr-progress').innerHTML = html;
  const setResults = (html) => $('sbr-results').innerHTML = html;
  const setPreview = (html) => $('sbr-preview').innerHTML = html;

  // ---------- CSV / TXT parsing ----------
  const parseEmailsFromText = (text) => {
    const isLikelyEmail = (s) => /^[^\s,;]+@[^\s,;]+\.[^\s,;]+$/.test(s);
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];

    // Detect CSV header
    const splitCsvLine = (l) => {
      // simple CSV split (handles quoted fields)
      const out = [];
      let cur = '', inQ = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (c === '"') { if (inQ && l[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
        else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map(s => s.trim().replace(/^"|"$/g,''));
    };

    const header = splitCsvLine(lines[0]);
    const emailColIdx = header.findIndex(h => h.toLowerCase() === 'email');

    let raw = [];
    if (emailColIdx !== -1) {
      // CSV with header row
      for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i]);
        if (cells[emailColIdx]) raw.push(cells[emailColIdx]);
      }
    } else {
      // No header — assume one email per line OR first column of a CSV without header
      raw = lines.map(l => {
        const first = splitCsvLine(l)[0];
        return first || l;
      });
    }

    // Filter to plausible emails, lowercase, dedup
    const seen = new Set();
    const out = [];
    for (let e of raw) {
      e = (e || '').trim().toLowerCase();
      if (!isLikelyEmail(e) || seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
    return out;
  };

  // ---------- Removal logic ----------
  const removeOne = async (email) => {
    const url = '/api/v1/subscriber/' + encodeURIComponent(email);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
        });
        if (r.status === 200) return 'ok';
        if (r.status === 404) return 'ok_already_gone';
        if (r.status === 429) {
          await new Promise(res => setTimeout(res, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        if (r.status === 401 || r.status === 403) return `http_${r.status}_check_login`;
        return `http_${r.status}`;
      } catch (e) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
          continue;
        }
        return 'fetch_error:' + (e.message || 'unknown');
      }
    }
    return 'max_retries_exceeded';
  };

  const runSweep = async (emails) => {
    let state = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null') || {
      total_planned: emails.length,
      index: 0,
      removed: [],
      errors: [],
    };
    // If a previous run was for a different list size, reset.
    if (state.total_planned !== emails.length) {
      state = { total_planned: emails.length, index: 0, removed: [], errors: [] };
    }

    $('sbr-start').style.display = 'none';
    $('sbr-stop').style.display = 'inline-block';
    $('sbr-stop').onclick = () => { window.__STOP_REMOVER = true; };

    const render = () => {
      const total = emails.length;
      const pct = ((state.index / total) * 100).toFixed(1);
      setProgress(
        `[${state.index}/${total} ${pct}%]<br>` +
        `Removed: ${state.removed.length}<br>` +
        `Errors: ${state.errors.length}`
      );
    };
    render();

    let cursor = state.index;
    let inflight = 0;
    let done = false;
    await new Promise(resolveAll => {
      const launchNext = () => {
        if (window.__STOP_REMOVER) {
          if (inflight === 0 && !done) { done = true; resolveAll(); }
          return;
        }
        while (inflight < CONCURRENCY && cursor < emails.length) {
          const myIdx = cursor++;
          const email = emails[myIdx];
          inflight++;
          (async () => {
            await new Promise(r => setTimeout(r, DELAY_PER_REQ_MS * (myIdx % CONCURRENCY)));
            const result = await removeOne(email);
            if (result === 'ok' || result === 'ok_already_gone') {
              state.removed.push(email);
            } else {
              state.errors.push({ email, result });
            }
            state.index = Math.max(state.index, myIdx + 1);
            if (myIdx % 25 === 0 || myIdx === emails.length - 1) {
              localStorage.setItem(PROGRESS_KEY, JSON.stringify(state));
            }
            render();
            inflight--;
            if (cursor >= emails.length && inflight === 0 && !done) {
              done = true;
              localStorage.setItem(PROGRESS_KEY, JSON.stringify(state));
              resolveAll();
            } else {
              launchNext();
            }
          })();
        }
      };
      launchNext();
    });

    localStorage.setItem(PROGRESS_KEY, JSON.stringify(state));
    $('sbr-stop').style.display = 'none';
    setProgress(`<b>Done.</b><br>Removed: ${state.removed.length}<br>Errors: ${state.errors.length}`);
    if (state.errors.length > 0) {
      setResults(
        `To copy errors to clipboard, run:<br>` +
        `<code style="user-select:all;display:block;background:#222;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;word-break:break-all;">copy(JSON.stringify(JSON.parse(localStorage.getItem('${PROGRESS_KEY}')).errors,null,2))</code>`
      );
    } else {
      setResults('All clean. Nice.');
    }
  };

  // ---------- Wire up file input ----------
  $('sbr-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const emails = parseEmailsFromText(text);
    if (emails.length === 0) {
      setPreview('<span style="color:#f87171;">No valid emails found in this file. Expected one email per line, or a CSV with an "email" column.</span>');
      return;
    }
    const sample = emails.slice(0, 5).join('<br>');
    setPreview(
      `<b>${emails.length} emails detected.</b><br>` +
      `<span style="opacity:0.7;">First few:</span><br>${sample}` +
      (emails.length > 5 ? `<br><span style="opacity:0.7;">…and ${emails.length - 5} more</span>` : '')
    );
    $('sbr-step2').style.display = 'block';
    $('sbr-start').onclick = () => {
      if (!confirm(`Remove ${emails.length} subscribers from this Substack publication?\n\nThis cannot be undone.`)) return;
      runSweep(emails);
    };
  });

  console.log('[Substack Bulk Remover] Panel installed. Upload your CSV/TXT in the top-right panel.');
})();
