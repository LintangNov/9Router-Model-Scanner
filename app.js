/**
 * app.js — 9Router Scanner Web UI
 * Modular ES6 async frontend logic
 *
 * Responsibilities:
 *   - Load models from /api/models and build provider chip UI
 *   - Sequential scan loop with circuit breaker per provider
 *   - Real-time terminal log updates
 *   - Recap panel population (active, skipped, failed)
 *   - All UI state transitions (idle / scanning / done / stopped)
 */

'use strict';

// ═══════════════════════════════════════════════
// DOM References — gathered once at startup
// ═══════════════════════════════════════════════
const dom = {
  // Header config
  inputBaseUrl:      () => document.getElementById('input-base-url'),
  inputApiKey:       () => document.getElementById('input-api-key'),
  btnToggleKey:      () => document.getElementById('btn-toggle-key'),
  iconEye:           () => document.getElementById('icon-eye'),
  iconEyeOff:        () => document.getElementById('icon-eye-off'),
  statusBackend:     () => document.getElementById('status-backend'),
  statusBackendVal:  () => document.getElementById('status-backend-val'),
  statusRouter:      () => document.getElementById('status-router'),
  statusRouterVal:   () => document.getElementById('status-router-val'),

  // Config panel
  btnLoadModels:     () => document.getElementById('btn-load-models'),
  chkSelectAll:      () => document.getElementById('chk-select-all'),
  providerChips:     () => document.getElementById('provider-chips'),
  providersEmptyHint:() => document.getElementById('providers-empty-hint'),
  chkCircuitBreaker: () => document.getElementById('chk-circuit-breaker'),
  cbStateLabel:      () => document.getElementById('cb-state-label'),
  inputThreshold:    () => document.getElementById('input-threshold'),
  btnStartScan:      () => document.getElementById('btn-start-scan'),
  btnStopScan:       () => document.getElementById('btn-stop-scan'),

  // Execution panel
  btnClearLog:       () => document.getElementById('btn-clear-log'),
  statTotal:         () => document.getElementById('stat-total'),
  statScanned:       () => document.getElementById('stat-scanned'),
  statActive:        () => document.getElementById('stat-active'),
  statFailed:        () => document.getElementById('stat-failed'),
  statSkipped:       () => document.getElementById('stat-skipped'),
  progressBarWrap:   () => document.getElementById('progress-bar-wrap'),
  progressFill:      () => document.getElementById('progress-fill'),
  progressLabel:     () => document.getElementById('progress-label'),
  terminalLog:       () => document.getElementById('terminal-log'),
  logIdle:           () => document.getElementById('log-idle'),

  // Recap panel
  recapBadge:        () => document.getElementById('recap-badge'),
  btnCopyActive:     () => document.getElementById('btn-copy-active'),
  listActiveModels:  () => document.getElementById('list-active-models'),
  listSkippedProviders: () => document.getElementById('list-skipped-providers'),
  listFailedModels:  () => document.getElementById('list-failed-models'),
};

// ═══════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════
/** @type {{ provider: string, models: string[] }[]} */
let loadedProviders = [];

/** Whether the scan loop should stop (set by Abort button) */
let scanAbortFlag = false;

/** Scan results accumulator */
const scanResults = {
  active:  [],   // model IDs that returned 200
  failed:  [],   // { model, status, error }
  skipped: [],   // provider names skipped by circuit breaker
};

// ═══════════════════════════════════════════════
// Utility helpers
// ═══════════════════════════════════════════════

/**
 * Build the request headers for /api/* endpoints.
 * The PowerShell server reads X-Router-Base and X-Api-Key headers.
 */
function buildApiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const baseUrl = dom.inputBaseUrl().value.trim();
  const apiKey  = dom.inputApiKey().value.trim();
  if (baseUrl) headers['X-Router-Base'] = baseUrl;
  if (apiKey)  headers['X-Api-Key']     = apiKey;
  return headers;
}

/**
 * Append a styled line to the terminal log and auto-scroll to bottom.
 * @param {string} text
 * @param {'ok'|'err'|'warn'|'info'|'muted'} [kind='muted']
 */
function logLine(text, kind = 'muted') {
  const log = dom.terminalLog();
  // Remove the idle placeholder on first real log line
  const idle = dom.logIdle();
  if (idle) idle.remove();

  const line = document.createElement('span');
  line.className = `log-line log-line--${kind}`;
  line.textContent = text;
  log.appendChild(line);

  const nl = document.createElement('span');
  nl.className = 'log-line';
  nl.textContent = '\n';
  log.appendChild(nl);

  // Auto-scroll to bottom
  log.scrollTop = log.scrollHeight;
}

/**
 * Pad a string to a fixed width for aligned log columns.
 * @param {string} s
 * @param {number} width
 */
function padEnd(s, width) {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Format ISO timestamp as HH:MM:SS for log prefix.
 */
function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

// ═══════════════════════════════════════════════
// Status Indicators
// ═══════════════════════════════════════════════

/**
 * Update a status pill state.
 * @param {HTMLElement} pill
 * @param {HTMLElement} valueEl
 * @param {'ok'|'err'|'warn'|'loading'} state
 * @param {string} label
 */
function setStatus(pill, valueEl, state, label) {
  pill.classList.remove('is-ok', 'is-err', 'is-warn');
  if (state === 'ok')   pill.classList.add('is-ok');
  if (state === 'err')  pill.classList.add('is-err');
  if (state === 'warn') pill.classList.add('is-warn');
  valueEl.textContent = label;
}

/**
 * Ping the local PowerShell server and check router reachability.
 */
async function checkStatus() {
  const backendPill = dom.statusBackend();
  const backendVal  = dom.statusBackendVal();
  const routerPill  = dom.statusRouter();
  const routerVal   = dom.statusRouterVal();

  setStatus(backendPill, backendVal, 'warn', 'checking...');
  setStatus(routerPill,  routerVal,  'warn', 'checking...');

  try {
    const res = await fetch('/api/models', { headers: buildApiHeaders(), signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      setStatus(backendPill, backendVal, 'ok', 'Online');
      setStatus(routerPill,  routerVal,  'ok', 'Reachable');
    } else {
      setStatus(backendPill, backendVal, 'ok',  'Online');
      setStatus(routerPill,  routerVal,  'err', `HTTP ${res.status}`);
    }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      setStatus(backendPill, backendVal, 'err', 'Offline');
      setStatus(routerPill,  routerVal,  'err', 'Unreachable');
    } else {
      // Backend may be online but router failed
      setStatus(backendPill, backendVal, 'warn', 'Unknown');
      setStatus(routerPill,  routerVal,  'err',  'Unreachable');
    }
  }
}

// ═══════════════════════════════════════════════
// Model Loading
// ═══════════════════════════════════════════════

/**
 * Fetch providers+models from /api/models and build the provider chip UI.
 */
async function loadModels() {
  const btn = dom.btnLoadModels();
  btn.disabled = true;
  btn.textContent = 'Loading...';

  const chipsContainer = dom.providerChips();
  chipsContainer.innerHTML = '<p class="empty-hint">Fetching models from router...</p>';

  try {
    const res = await fetch('/api/models', {
      headers: buildApiHeaders(),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from /api/models`);
    }

    const data = await res.json();
    loadedProviders = data.providers || [];

    if (loadedProviders.length === 0) {
      chipsContainer.innerHTML = '<p class="empty-hint">No models found. Check Router URL and API Key.</p>';
      setEnableStartScan(false);
      return;
    }

    renderProviderChips(loadedProviders);
    setEnableStartScan(true);
    logLine(`[${timestamp()}] Loaded ${loadedProviders.length} providers, ${countTotalModels(loadedProviders)} models.`, 'info');

    // Re-check status now that we confirmed connectivity
    setStatus(dom.statusBackend(), dom.statusBackendVal(), 'ok', 'Online');
    setStatus(dom.statusRouter(),  dom.statusRouterVal(),  'ok', 'Reachable');

  } catch (err) {
    chipsContainer.innerHTML = `<p class="empty-hint" style="color: var(--error)">Error: ${escapeHtml(err.message)}</p>`;
    setEnableStartScan(false);
    logLine(`[${timestamp()}] Failed to load models: ${err.message}`, 'err');
    setStatus(dom.statusBackend(), dom.statusBackendVal(), 'err', 'Offline');
    setStatus(dom.statusRouter(),  dom.statusRouterVal(),  'err', 'Error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load Models';
  }
}

/**
 * Count total models across all providers.
 * @param {Array} providers
 */
function countTotalModels(providers) {
  return providers.reduce((sum, p) => sum + p.models.length, 0);
}

/**
 * Render provider selection chips from loaded providers data.
 * @param {Array} providers
 */
function renderProviderChips(providers) {
  const container = dom.providerChips();
  container.innerHTML = '';

  providers.forEach(({ provider, models }) => {
    const chip = document.createElement('label');
    chip.className = 'provider-chip is-checked';
    chip.setAttribute('data-provider', provider);

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = true;
    chk.value = provider;
    chk.setAttribute('aria-label', `Include provider ${provider} (${models.length} models)`);

    chk.addEventListener('change', onProviderChipChange);

    const name = document.createElement('span');
    name.textContent = provider;

    const count = document.createElement('span');
    count.className = 'chip-count';
    count.textContent = `(${models.length})`;

    chip.appendChild(chk);
    chip.appendChild(name);
    chip.appendChild(count);
    container.appendChild(chip);
  });

  // Sync select-all state
  syncSelectAllState();
}

/**
 * Handle provider chip checkbox change.
 */
function onProviderChipChange(evt) {
  const chk   = evt.target;
  const label = chk.closest('.provider-chip');
  if (label) {
    label.classList.toggle('is-checked', chk.checked);
  }
  syncSelectAllState();
}

/**
 * Sync the "Select All" checkbox based on individual chip states.
 */
function syncSelectAllState() {
  const all   = getProviderCheckboxes();
  const selectAll = dom.chkSelectAll();
  const checked   = all.filter(c => c.checked).length;
  if (checked === 0) {
    selectAll.checked       = false;
    selectAll.indeterminate = false;
  } else if (checked === all.length) {
    selectAll.checked       = true;
    selectAll.indeterminate = false;
  } else {
    selectAll.checked       = false;
    selectAll.indeterminate = true;
  }
}

/**
 * Return all provider chip checkboxes.
 * @returns {HTMLInputElement[]}
 */
function getProviderCheckboxes() {
  return Array.from(dom.providerChips().querySelectorAll('input[type="checkbox"]'));
}

/**
 * Return provider names that are currently checked.
 * @returns {string[]}
 */
function getSelectedProviders() {
  return getProviderCheckboxes()
    .filter(c => c.checked)
    .map(c => c.value);
}

// ═══════════════════════════════════════════════
// UI State Helpers
// ═══════════════════════════════════════════════

function setEnableStartScan(enabled) {
  const btn = dom.btnStartScan();
  btn.disabled = !enabled;
  btn.setAttribute('aria-disabled', String(!enabled));
}

/**
 * Switch to scanning UI state.
 */
function enterScanningState() {
  dom.btnStartScan().classList.add('hidden');
  dom.btnStopScan().classList.remove('hidden');
  dom.btnLoadModels().disabled = true;
  dom.inputBaseUrl().disabled  = true;
  dom.inputApiKey().disabled   = true;
  getProviderCheckboxes().forEach(c => { c.disabled = true; });
  dom.chkSelectAll().disabled   = true;
  dom.chkCircuitBreaker().disabled = true;
  dom.inputThreshold().disabled    = true;
}

/**
 * Switch back to idle UI state.
 */
function enterIdleState() {
  dom.btnStartScan().classList.remove('hidden');
  const stopBtn = dom.btnStopScan();
  stopBtn.classList.add('hidden');
  stopBtn.disabled = false;
  stopBtn.textContent = 'Abort Scan';
  dom.btnLoadModels().disabled = false;
  dom.inputBaseUrl().disabled  = false;
  dom.inputApiKey().disabled   = false;
  getProviderCheckboxes().forEach(c => { c.disabled = false; });
  dom.chkSelectAll().disabled   = false;
  dom.chkCircuitBreaker().disabled = false;
  dom.inputThreshold().disabled    = false;
  setEnableStartScan(loadedProviders.length > 0);
}

// ═══════════════════════════════════════════════
// Stats & Progress
// ═══════════════════════════════════════════════

const stats = { total: 0, scanned: 0, active: 0, failed: 0, skipped: 0 };

function resetStats(total) {
  stats.total   = total;
  stats.scanned = 0;
  stats.active  = 0;
  stats.failed  = 0;
  stats.skipped = 0;
  updateStatDisplay();
  updateProgress(0, total);
}

function updateStatDisplay() {
  dom.statTotal().textContent   = String(stats.total);
  dom.statScanned().textContent = String(stats.scanned);
  dom.statActive().textContent  = String(stats.active);
  dom.statFailed().textContent  = String(stats.failed);
  dom.statSkipped().textContent = String(stats.skipped);
}

function updateProgress(scanned, total) {
  const pct = total > 0 ? Math.round((scanned / total) * 100) : 0;
  dom.progressFill().style.width = `${pct}%`;
  dom.progressBarWrap().setAttribute('aria-valuenow', String(pct));
  dom.progressLabel().textContent = `${scanned} / ${total}`;
}

// ═══════════════════════════════════════════════
// Recap Panel
// ═══════════════════════════════════════════════

function resetRecap() {
  scanResults.active  = [];
  scanResults.failed  = [];
  scanResults.skipped = [];
  renderRecapList(dom.listActiveModels(),   []);
  renderRecapList(dom.listSkippedProviders(), []);
  renderRecapList(dom.listFailedModels(),   []);
  dom.recapBadge().classList.add('hidden');
  dom.btnCopyActive().disabled = true;
  dom.btnCopyActive().setAttribute('aria-disabled', 'true');
}

/**
 * Render a model/provider list into a recap card.
 * @param {HTMLUListElement} ulEl
 * @param {string[]} items
 * @param {'is-active'|'is-skipped'|'is-failed'} [cssClass]
 * @param {string} [emptyMsg]
 */
function renderRecapList(ulEl, items, cssClass = '', emptyMsg = 'None.') {
  ulEl.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'model-list__empty';
    li.textContent = emptyMsg;
    ulEl.appendChild(li);
    return;
  }
  items.forEach(item => {
    const li = document.createElement('li');
    if (cssClass) li.className = cssClass;
    li.textContent = typeof item === 'string' ? item : `${item.model} [${item.status || item.error || '?'}]`;
    ulEl.appendChild(li);
  });
}

/**
 * Push a new active model to the live recap.
 * @param {string} model
 */
function addActiveModel(model) {
  scanResults.active.push(model);
  const ul = dom.listActiveModels();
  // Remove empty placeholder if present
  const empty = ul.querySelector('.model-list__empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.className = 'is-active';
  li.textContent = model;
  ul.appendChild(li);

  dom.btnCopyActive().disabled = false;
  dom.btnCopyActive().setAttribute('aria-disabled', 'false');
}

/**
 * Push a failed model to the live recap.
 * @param {{ model: string, status: number, error?: string }} entry
 */
function addFailedModel(entry) {
  scanResults.failed.push(entry);
  const ul = dom.listFailedModels();
  const empty = ul.querySelector('.model-list__empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.className = 'is-failed';
  li.textContent = `${entry.model} [${entry.status || entry.error || 'ERR'}]`;
  ul.appendChild(li);
}

/**
 * Push a skipped provider to the live recap.
 * @param {string} provider
 * @param {string} reason
 */
function addSkippedProvider(provider, reason) {
  const label = `${provider}: ${reason}`;
  scanResults.skipped.push(label);
  const ul = dom.listSkippedProviders();
  const empty = ul.querySelector('.model-list__empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.className = 'is-skipped';
  li.textContent = label;
  ul.appendChild(li);
}

// ═══════════════════════════════════════════════
// Core Scan Engine
// ═══════════════════════════════════════════════

/**
 * Scan a single model via POST /api/scan-single.
 * Returns { ok, status, error? }
 * @param {string} model
 * @returns {Promise<{ ok: boolean, status: number, error?: string }>}
 */
async function scanModel(model) {
  try {
    const res = await fetch('/api/scan-single', {
      method: 'POST',
      headers: buildApiHeaders(),
      body: JSON.stringify({ model }),
      // Note: the PowerShell server enforces the 7-second timeout on the 9Router side.
      // We set a slightly longer client timeout to account for network overhead.
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    return { ok: data.ok === true, status: data.status || 0, error: data.error };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, status: 0, error: 'timeout' };
    }
    return { ok: false, status: 0, error: err.message };
  }
}

/**
 * Main sequential scan loop.
 * Iterates over selected providers and their models,
 * applies circuit breaker logic per provider.
 */
async function runScan() {
  const selectedProviders = getSelectedProviders();
  if (selectedProviders.length === 0) {
    logLine(`[${timestamp()}] No providers selected. Select at least one provider before scanning.`, 'warn');
    return;
  }

  const cbEnabled  = dom.chkCircuitBreaker().checked;
  const threshold  = Math.max(1, parseInt(dom.inputThreshold().value, 10) || 10);

  // Collect all models to scan, respecting provider filter
  const providerQueue = loadedProviders.filter(p => selectedProviders.includes(p.provider));
  const totalModels   = countTotalModels(providerQueue);

  if (totalModels === 0) {
    logLine(`[${timestamp()}] No models found for selected providers.`, 'warn');
    return;
  }

  // Enter scanning UI state
  enterScanningState();
  resetStats(totalModels);
  resetRecap();
  scanAbortFlag = false;

  // Clear log
  const log = dom.terminalLog();
  log.innerHTML = '';

  logLine(`[${timestamp()}] ── Scan started ────────────────────────────────────`, 'info');
  logLine(`[${timestamp()}]    Providers : ${providerQueue.length}`, 'muted');
  logLine(`[${timestamp()}]    Models    : ${totalModels}`, 'muted');
  logLine(`[${timestamp()}]    CB Mode   : ${cbEnabled ? `ON (threshold=${threshold})` : 'OFF'}`, 'muted');
  logLine(`[${timestamp()}] ────────────────────────────────────────────────────`, 'muted');

  let globalScanned = 0;

  for (const { provider, models } of providerQueue) {
    if (scanAbortFlag) {
      logLine(`[${timestamp()}] !! Scan aborted by user.`, 'warn');
      break;
    }

    let consecutiveFailures = 0;
    let providerSkipped     = false;

    logLine(`[${timestamp()}] >> Provider: ${provider} (${models.length} models)`, 'info');

    for (const model of models) {
      if (scanAbortFlag) {
        logLine(`[${timestamp()}] !! Scan aborted by user.`, 'warn');
        break;
      }

      // ── Circuit Breaker: skip remaining models in this provider ──
      if (cbEnabled && consecutiveFailures >= threshold) {
        const remaining = models.length - models.indexOf(model);
        stats.skipped += remaining;
        globalScanned += remaining;
        updateStatDisplay();
        updateProgress(globalScanned, totalModels);

        for (const skippedModel of models.slice(models.indexOf(model))) {
          logLine(
            `[${timestamp()}]    ${padEnd('SKIPPED', 9)} ${padEnd(skippedModel, 60)} (circuit broken)`,
            'warn'
          );
        }

        providerSkipped = true;
        break;
      }

      // ── Test the model ──
      const result = await scanModel(model);
      globalScanned++;
      stats.scanned++;

      if (result.ok) {
        stats.active++;
        consecutiveFailures = 0;
        addActiveModel(model);
        logLine(
          `[${timestamp()}]    ${padEnd('200 OK', 9)} ${model}`,
          'ok'
        );
      } else {
        stats.failed++;
        consecutiveFailures++;
        const label = result.error === 'timeout'
          ? 'TIMEOUT'
          : result.status > 0 ? `HTTP ${result.status}` : 'ERR';
        addFailedModel({ model, status: result.status, error: result.error });
        logLine(
          `[${timestamp()}]    ${padEnd(label, 9)} ${padEnd(model, 60)} ${result.error ? `(${result.error})` : ''}`.trimEnd(),
          'err'
        );
      }

      updateStatDisplay();
      updateProgress(globalScanned, totalModels);
    }

    if (providerSkipped) {
      addSkippedProvider(provider, `threshold reached (${threshold} consecutive failures)`);
      logLine(
        `[${timestamp()}] !! Provider ${provider} circuit broken after ${threshold} failures. Remaining models skipped.`,
        'warn'
      );
    }
  }

  // ── Scan complete ──
  const wasAborted = scanAbortFlag;
  logLine(`[${timestamp()}] ── Scan ${wasAborted ? 'aborted' : 'complete'} ──────────────────────────────────────`, 'info');
  logLine(`[${timestamp()}]    Active  : ${stats.active}`, 'ok');
  logLine(`[${timestamp()}]    Failed  : ${stats.failed}`, stats.failed > 0 ? 'err' : 'muted');
  logLine(`[${timestamp()}]    Skipped : ${stats.skipped}`, stats.skipped > 0 ? 'warn' : 'muted');
  logLine(`[${timestamp()}] ────────────────────────────────────────────────────`, 'muted');

  // Show recap badge
  const badge = dom.recapBadge();
  badge.textContent = wasAborted ? 'Scan aborted' : 'Scan complete';
  badge.classList.remove('hidden');

  enterIdleState();
}

// ═══════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════

/** Toggle API key visibility */
function onToggleApiKey() {
  const input  = dom.inputApiKey();
  const btn    = dom.btnToggleKey();
  const eye    = dom.iconEye();
  const eyeOff = dom.iconEyeOff();
  const isShown = input.type === 'text';

  input.type = isShown ? 'password' : 'text';
  btn.setAttribute('aria-pressed', String(!isShown));
  eye.classList.toggle('hidden', !isShown);
  eyeOff.classList.toggle('hidden', isShown);
}

/** Select All / Deselect All providers */
function onSelectAllChange() {
  const selectAll = dom.chkSelectAll();
  getProviderCheckboxes().forEach(chk => {
    chk.checked = selectAll.checked;
    const label = chk.closest('.provider-chip');
    if (label) label.classList.toggle('is-checked', chk.checked);
  });
}

/** Circuit breaker toggle label update */
function onCircuitBreakerChange() {
  const chk   = dom.chkCircuitBreaker();
  const label = dom.cbStateLabel();
  label.textContent = chk.checked ? 'ON' : 'OFF';
  chk.setAttribute('aria-checked', String(chk.checked));
}

/** Clear log */
function onClearLog() {
  const log = dom.terminalLog();
  log.innerHTML = '';
  const placeholder = document.createElement('p');
  placeholder.id = 'log-idle';
  placeholder.className = 'log-line log-line--muted';
  placeholder.textContent = 'Log cleared. Waiting for scan to start...';
  log.appendChild(placeholder);
}

/** Copy active models list to clipboard */
async function onCopyActiveModels() {
  const btn = dom.btnCopyActive();
  if (scanResults.active.length === 0) return;

  try {
    await navigator.clipboard.writeText(scanResults.active.join('\n'));
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = scanResults.active.length === 0;
      btn.setAttribute('aria-disabled', String(scanResults.active.length === 0));
    }, 1500);
  } catch {
    // Clipboard API not available in all contexts — fallback: select text
    logLine(`[${timestamp()}] Clipboard unavailable. Copy manually from the Active Models list.`, 'warn');
  }
}

// ═══════════════════════════════════════════════
// Safe HTML escape (for user-provided error messages)
// ═══════════════════════════════════════════════
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════
// Bootstrap — wire up all event listeners on DOM ready
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // API key toggle
  dom.btnToggleKey().addEventListener('click', onToggleApiKey);

  // Load models
  dom.btnLoadModels().addEventListener('click', loadModels);

  // Select All
  dom.chkSelectAll().addEventListener('change', onSelectAllChange);

  // Circuit breaker toggle
  dom.chkCircuitBreaker().addEventListener('change', onCircuitBreakerChange);

  // Start scan
  dom.btnStartScan().addEventListener('click', () => {
    if (!dom.btnStartScan().disabled) {
      runScan();
    }
  });

  // Abort scan
  dom.btnStopScan().addEventListener('click', () => {
    scanAbortFlag = true;
    dom.btnStopScan().disabled = true;
    dom.btnStopScan().textContent = 'Stopping...';
  });

  // Clear log
  dom.btnClearLog().addEventListener('click', onClearLog);

  // Copy active models
  dom.btnCopyActive().addEventListener('click', onCopyActiveModels);

  // Initial status check (non-blocking, runs in background)
  checkStatus();
});
