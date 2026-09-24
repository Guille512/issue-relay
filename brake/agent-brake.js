#!/usr/bin/env node
/**
 * agent-brake.js — consumer-side brake for agent loops. Call it BEFORE invoking a model.
 *
 * A router that lets agents ask each other for things is a machine for spending credit unless
 * every consumer can stop a conversation that turned into a loop. A label nobody checks is a
 * signal, not a brake; this limits EXECUTIONS:
 *
 *   1. The brake label on the issue -> no invocation. Only a human removes it.
 *   2. Same last comment already processed MAX_SAME times -> no re-invocation (a crashing run
 *      does not burn credit forever on the same state).
 *   3. Budget: MAX_24H invocations per issue per agent in a rolling 24h. Going over sets the brake
 *      label (and notifies). Sticky: the window only counts, it never releases. When a human
 *      removes the label, that issue's counter starts again from zero.
 *
 * The reservation is written BEFORE the model runs: a run that dies still counts.
 * Fails closed: unreadable state or a gh error -> exit 3 and the consumer invokes nothing.
 *
 * Usage:
 *   node agent-brake.js --agent frontend --issues 12,34 --config config.json [--repo owner/name]
 *                       [--state-dir DIR] [--notify-cmd "cmd that reads the message on stdin"]
 *     -> prints the allowed issue numbers, space separated ("12 34"); empty line = nothing allowed
 *   node agent-brake.js --self-test
 * Exit: 0 decided · 2 bad usage · 3 could not decide (do NOT invoke anything).
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY_MS = 24 * 3600 * 1000;
const DEFAULTS = { label: 'agents:brake', max24h: 6, maxSame: 3 };

// Pure. st = { uses:[ms], braked:bool, lastId, same, pendingBrake? }
function decide(st, { labels, lastId }, nowMs, lim = DEFAULTS) {
  st = st || { uses: [], braked: false, lastId: null, same: 0 };
  // Brake seen (set by this agent or another): remember it, so this agent also resets when a human removes it.
  if (labels.includes(lim.label)) return { ok: false, reason: 'brake', st: { ...st, braked: true, pendingBrake: false } };
  if (st.braked) st = { uses: [], braked: false, lastId: null, same: 0 }; // a human removed the label
  // Setting the label failed on a previous run: still braked even after the 24h window.
  if (st.pendingBrake) return { ok: false, reason: 'budget', brake: true, st };
  if (lastId !== null && lastId === st.lastId && st.same >= lim.maxSame) return { ok: false, reason: 'already-processed', st };
  const uses = st.uses.filter((t) => nowMs - t < DAY_MS);
  if (uses.length >= lim.max24h) return { ok: false, reason: 'budget', brake: true, st: { ...st, uses, pendingBrake: true } };
  return { ok: true, st: { uses: [...uses, nowMs], braked: false, lastId, same: lastId === st.lastId ? st.same + 1 : 1 } };
}

// Valid JSON is not enough: a record with the wrong shape would silently reset or corrupt the budget.
function validState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('state must be an object keyed by issue number');
  for (const [k, r] of Object.entries(s)) {
    const bad = (why) => { throw new Error(`issue ${k}: ${why}`); };
    if (!/^[1-9]\d*$/.test(k)) bad('key is not an issue number');
    if (!r || typeof r !== 'object' || Array.isArray(r)) bad('record is not an object');
    if (!Array.isArray(r.uses) || !r.uses.every((t) => Number.isFinite(t))) bad('uses must be finite timestamps');
    if (typeof r.braked !== 'boolean') bad('braked must be boolean');
    if (!(r.lastId === null || typeof r.lastId === 'string')) bad('lastId must be string or null');
    if (!Number.isInteger(r.same) || r.same < 0) bad('same must be a non-negative integer');
    if (r.pendingBrake !== undefined && typeof r.pendingBrake !== 'boolean') bad('pendingBrake must be boolean');
  }
  return s;
}

const arg = (argv, name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const agent = arg(argv, '--agent', '').toLowerCase();
  const list = arg(argv, '--issues', '').split(/[,\s#]+/).filter(Boolean).map(Number).filter((n) => n > 0);
  if (!agent || argv.indexOf('--issues') < 0) {
    console.error('Usage: --agent <name> --issues 12,34 --config file [--repo o/r] [--state-dir dir] [--notify-cmd cmd] | --self-test');
    return 2;
  }
  let lim = { ...DEFAULTS };
  let canonical = agent;
  const cfgFile = arg(argv, '--config', null);
  if (!cfgFile) { console.error('[brake] --config is required: the brake must read the same labels and agents as the router'); return 2; }
  {
    // Same loader and validation as the router: one config, one brake label, canonical agent names.
    const { loadConfig } = require('../template/.github/relay/router.js');
    const c = loadConfig(cfgFile);
    canonical = c.alias[agent.normalize('NFC')];
    if (!canonical) { console.error(`[brake] "${agent}" is not an agent in ${cfgFile}`); return 2; }
    const posInt = (v, d) => (v === undefined ? d : Number.isInteger(v) && v > 0 ? v : NaN);
    lim = { label: c.labels.brake, max24h: posInt(c.brake && c.brake.max24h, lim.max24h), maxSame: posInt(c.brake && c.brake.maxSame, lim.maxSame) };
    if (Number.isNaN(lim.max24h) || Number.isNaN(lim.maxSame)) { console.error('[brake] brake.max24h / brake.maxSame must be positive integers'); return 2; }
  }
  const repo = (arg(argv, '--repo', null) || process.env.GITHUB_REPOSITORY || JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner).toLowerCase();
  // State per repo + canonical agent: issue #12 of one repo is not #12 of another, and aliases share one budget.
  const file = path.join(arg(argv, '--state-dir', path.join(os.homedir(), '.issue-relay')), `brake-${repo.replace(/[^\w.-]+/g, '_')}-${canonical}.json`);
  // Corrupt state = braked (fail closed): a truncated file must not silently reset the budget.
  let state = {};
  if (fs.existsSync(file)) {
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); validState(state); } catch (e) {
      console.error(`[brake] unreadable state ${file}: ${e.message} — nothing is invoked until it is checked`);
      return 3;
    }
  }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 1)); fs.renameSync(file + '.tmp', file); };
  const notifyCmd = arg(argv, '--notify-cmd', process.env.RELAY_NOTIFY_CMD || '');
  const notify = (text) => {
    if (!notifyCmd) return;
    try { execFileSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', notifyCmd] : ['-c', notifyCmd], { input: text, timeout: 30000 }); }
    catch (e) { console.error(`[brake] notify failed: ${e.message}`); }
  };

  // Limit of the guarantee: an invocation authorized BEFORE another agent sets the label still runs
  // (a window of seconds). One instance per agent is the scheduler's job (cron flock, IgnoreNew...).
  const allowed = [];
  let rc = 0;
  const now = Date.now();
  for (const n of list) {
    let labels, lastId;
    try {
      // Via the API: the last comment comes from the last page, no truncation involved.
      const iss = JSON.parse(gh(['api', `repos/${repo}/issues/${n}`]));
      labels = iss.labels.map((l) => l.name);
      lastId = null;
      if (iss.comments > 0) {
        const last = JSON.parse(gh(['api', `repos/${repo}/issues/${n}/comments?per_page=1&page=${iss.comments}`]));
        lastId = last.length ? String(last[0].id) : null;
      }
    } catch (e) {
      console.error(`[brake] gh failed on #${n}: ${String(e.message).slice(0, 200)}`);
      save();
      return 3;
    }
    const d = decide(state[n], { labels, lastId }, now, lim);
    state[n] = d.st;
    if (d.ok) { allowed.push(n); continue; }
    console.error(`[brake] ${agent} #${n}: ${d.reason}`);
    if (d.brake) {
      try {
        gh(['issue', 'edit', String(n), '--repo', repo, '--add-label', lim.label]);
        state[n] = { ...state[n], braked: true, pendingBrake: false };
        notify(`Agent brake on #${n}: ${agent} reached ${lim.max24h} invocations in 24h. No agent runs there until the ${lim.label} label is removed.`);
      } catch (e) {
        // pendingBrake stays true: the issue stays braked for this agent and the label is retried.
        console.error(`[brake] could not set ${lim.label} on #${n}: ${String(e.message).slice(0, 200)}`);
        rc = 3; // the consumer invokes NOTHING this run
      }
    }
  }
  save();
  if (rc) return rc;
  console.log(allowed.join(' '));
  return 0;
}

function selfTest() {
  const assert = require('assert');
  const L = DEFAULTS.label, MAX = DEFAULTS.max24h, SAME = DEFAULTS.maxSame;
  const T0 = Date.parse('2030-01-01T00:00:00Z');
  const noL = { labels: [], lastId: 'c1' };
  let r, st;
  assert.strictEqual(decide(undefined, { labels: [L], lastId: 'c1' }, T0).reason, 'brake');
  // null state / issue without comments: allowed, and lastId null never counts as "already processed"
  r = decide(undefined, { labels: [], lastId: null }, T0); assert.ok(r.ok);
  r = decide(r.st, { labels: [], lastId: null }, T0 + 1); assert.ok(r.ok);
  r = decide(r.st, { labels: [], lastId: null }, T0 + 2); assert.ok(r.ok);
  // same comment: SAME attempts, then already-processed
  r = decide(undefined, noL, T0);
  for (let i = 1; i < SAME; i++) { assert.ok(r.ok, 'attempt ' + i); r = decide(r.st, noL, T0 + i); }
  assert.ok(r.ok); r = decide(r.st, noL, T0 + 9); assert.strictEqual(r.reason, 'already-processed');
  // brake set by ANOTHER agent: this one records it and resets when the human removes it
  st = { uses: [T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4], braked: false, lastId: 'z', same: 1 };
  r = decide(st, { labels: [L], lastId: 'z2' }, T0 + 5); assert.strictEqual(r.reason, 'brake');
  r = decide(r.st, { labels: [], lastId: 'z3' }, T0 + 6); assert.ok(r.ok); assert.strictEqual(r.st.uses.length, 1);
  // setting the label failed (pendingBrake): still braked after the 24h window
  r = decide({ uses: [], braked: false, lastId: 'q', same: 1, pendingBrake: true }, { labels: [], lastId: 'q2' }, T0 + 3 * DAY_MS);
  assert.strictEqual(r.reason, 'budget'); assert.ok(r.brake);
  // budget: MAX new comments in 24h pass, the next one brakes
  st = undefined;
  for (let i = 0; i < MAX; i++) { r = decide(st, { labels: [], lastId: 'n' + i }, T0 + i); assert.ok(r.ok, 'use ' + i); st = r.st; }
  r = decide(st, { labels: [], lastId: 'n7' }, T0 + 10); assert.strictEqual(r.reason, 'budget'); assert.ok(r.brake);
  // sticky: with the label on it stays braked after the window
  st = { ...r.st, braked: true };
  assert.strictEqual(decide(st, { labels: [L], lastId: 'n8' }, T0 + 2 * DAY_MS).reason, 'brake');
  // human removes the label -> reset
  r = decide(st, { labels: [], lastId: 'n8' }, T0 + 2 * DAY_MS); assert.ok(r.ok); assert.strictEqual(r.st.uses.length, 1);
  // if setting the label failed (braked=false), NO reset: still over budget inside the window
  st = { uses: Array.from({ length: MAX }, (_, i) => T0 + i), braked: false, lastId: 'x', same: 1 };
  assert.strictEqual(decide(st, { labels: [], lastId: 'y' }, T0 + 100).reason, 'budget');
  // rolling window: uses older than 24h do not count
  assert.ok(decide(st, { labels: [], lastId: 'y' }, T0 + DAY_MS + 10).ok);
  // any other label does not brake; custom limits are honored
  assert.ok(decide(undefined, { labels: ['review', 'blocked'], lastId: 'c' }, T0).ok);
  const lim2 = { label: 'stop', max24h: 1, maxSame: 1 };
  r = decide(undefined, { labels: [], lastId: 'a' }, T0, lim2); assert.ok(r.ok);
  assert.strictEqual(decide(r.st, { labels: [], lastId: 'b' }, T0 + 1, lim2).reason, 'budget');
  assert.strictEqual(decide(undefined, { labels: ['stop'], lastId: 'a' }, T0, lim2).reason, 'brake');
  // state shape: valid JSON with the wrong shape must be rejected (fail closed), a real state passes
  for (const bad of [[], null, { 12: [] }, { x: { uses: [], braked: false, lastId: null, same: 0 } },
    { 12: { uses: ['a'], braked: false, lastId: null, same: 0 } }, { 12: { uses: [], braked: 'no', lastId: null, same: 0 } },
    { 12: { uses: [], braked: false, lastId: 5, same: 0 } }, { 12: { uses: [], braked: false, lastId: null, same: -1 } }]) {
    assert.throws(() => validState(bad), JSON.stringify(bad));
  }
  let real = {}; r = decide(undefined, { labels: [], lastId: 'c' }, T0); real[7] = r.st;
  r = decide({ uses: [], braked: false, lastId: 'q', same: 1, pendingBrake: true }, { labels: [], lastId: 'q2' }, T0); real[8] = r.st;
  assert.doesNotThrow(() => validState(JSON.parse(JSON.stringify(real))));
  // end to end: main() on a malformed state file exits 3 BEFORE touching the network
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-brake-'));
  fs.writeFileSync(path.join(dir, 'brake-o_r-frontend.json'), '[]');
  const cfgEx = path.join(__dirname, '../template/.github/relay/config.example.json');
  const errs = [], origErr = console.error;
  console.error = (m) => errs.push(String(m)); // rc 3 alone could also come from gh failing on the fake repo
  return main(['--agent', 'frontend', '--issues', '1', '--repo', 'o/r', '--config', cfgEx, '--state-dir', dir]).then((rc) => {
    console.error = origErr;
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(rc, 3, 'malformed state must fail closed');
    assert.ok(errs.some((e) => e.includes('unreadable state')) && !errs.some((e) => e.includes('gh failed')), 'must stop on the state, before any gh call');
    console.log('[brake] self-test OK (label, nulls, same-id, foreign brake + reset, pendingBrake, budget, sticky, reset, window, custom limits, state shape)');
    return 0;
  });
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(3); });
module.exports = { decide, DEFAULTS };
