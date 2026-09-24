#!/usr/bin/env node
/**
 * check-relay.js — watchdog for the router. Run it from cron / a scheduled task and wire
 * a non-zero exit to your alerting. The router is a GitHub Action: if it stops (workflow
 * disabled, Actions minutes exhausted, token without permission, file deleted), nothing
 * tells you — the commands just stay as text and tickets stop moving.
 *
 * Checks, all by EFFECT, over the comments of the last 26 hours. Run it at least every few hours:
 * a failure older than the window stops being reported (the workflow check keeps firing).
 *   1. a command by the owner, older than GRACE minutes, with no 🚀 or 😕 FROM THE BOT -> the router did not run
 *   2. the issue-relay workflow is not `active`
 *
 * Usage: node tools/check-relay.js --repo owner/name [--config .github/relay/config.json] [--grace 20]
 *        node tools/check-relay.js --self-test
 * Exit: 0 healthy · 1 problems found (printed, one per line) · 2 bad usage · 3 could not check.
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const { parse, loadConfig } = require('../template/.github/relay/router.js');
const BOT = 'github-actions[bot]';

// Pure. `botMarked(id)` = the bot put 🚀 or 😕 on that comment; `closed(url)` = that issue is closed.
function analyze({ comments, nowMs, owner, cfg, workflowState, graceMin, botMarked, closed }) {
  const problems = [];
  for (const c of comments || []) {
    if (String(c.html_url || '').includes('/pull/')) continue; // the workflow ignores pull requests on purpose
    if (c.user?.login !== (cfg.poster || owner) || !(Date.parse(c.created_at) > Date.parse(cfg.activation)) || !parse(c.body, cfg)) continue;
    if (nowMs - Date.parse(c.created_at) < graceMin * 60000) continue;
    if (botMarked(c.id) || closed(c.issue_url)) continue;
    problems.push(`command not processed: #${String(c.issue_url).split('/').pop()} comment ${c.id} is older than ${graceMin} min with no 🚀/😕 from the bot`);
  }
  if (workflowState !== 'active') problems.push(`workflow issue-relay is "${workflowState}": commands do not move labels (gh workflow enable issue-relay)`);
  return problems;
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const repo = arg('--repo', null);
  const graceMin = Number(arg('--grace', 20));
  if (!repo || !Number.isFinite(graceMin) || graceMin < 0) { console.error('Usage: --repo owner/name [--config file] [--grace minutes>=0] | --self-test'); return 2; }
  try {
    const cfg = loadConfig(arg('--config', path.join(process.cwd(), '.github/relay/config.json')));
    const gh = (a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', timeout: 30000 }));
    const pages = (url) => { const all = []; for (let p = 1; ; p++) { const pg = gh(['api', `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${p}`]); all.push(...pg); if (pg.length < 100) return all; } };
    const now = Date.now();
    const comments = pages(`repos/${repo}/issues/comments?since=${new Date(now - 26 * 3600000).toISOString()}`);
    const workflowState = gh(['api', `repos/${repo}/actions/workflows/issue-relay.yml`]).state;
    const marked = new Set(), closedSet = new Set();
    for (const c of comments) {
      if (!parse(c.body, cfg)) continue;
      if (pages(`repos/${repo}/issues/comments/${c.id}/reactions`).some((r) => r.user.login === BOT && (r.content === 'rocket' || r.content === 'confused'))) { marked.add(c.id); continue; }
      if (gh(['api', String(c.issue_url).replace('https://api.github.com/', '')]).state === 'closed') closedSet.add(c.issue_url);
    }
    const problems = analyze({ comments, nowMs: now, owner: repo.split('/')[0], cfg, workflowState, graceMin,
      botMarked: (id) => marked.has(id), closed: (u) => closedSet.has(u) });
    problems.forEach((p) => console.log(p));
    return problems.length ? 1 : 0;
  } catch (e) {
    console.error(`[check-relay] could not check: ${e.message}`);
    return 3;
  }
}

function selfTest() {
  const assert = require('assert');
  const cfg = loadConfig(path.join(__dirname, '../template/.github/relay/config.example.json'));
  const now = Date.parse('2030-01-05T12:00:00Z');
  const c = (id, body, minAgo, user = 'octo') => ({ id, body, user: { login: user },
    created_at: new Date(now - minAgo * 60000).toISOString(), issue_url: 'https://api.github.com/repos/octo/ch/issues/7' });
  const base = { nowMs: now, owner: 'octo', cfg, workflowState: 'active', graceMin: 20, botMarked: () => false, closed: () => false };
  assert.strictEqual(analyze({ ...base, comments: [c(1, '**Planner → Frontend:** /ask x', 30)] }).length, 1, 'unprocessed command fires');
  // a 🚀 put by someone else does NOT count as processed
  assert.strictEqual(analyze({ ...base, comments: [c(1, '**Planner → Frontend:** /ask x', 30)], botMarked: (id) => id === 99 }).length, 1);
  const healthy = [c(1, '**Planner → Frontend:** /ask x', 30), c(3, '**Planner → Frontend:** /ask x', 5), c(4, '**Planner:** thanks', 300),
    c(5, '**Planner → Frontend:** /ask x', 30, 'other'), { ...c(6, '**Planner → Frontend:** /ask x', 0), created_at: '2020-01-01T00:00:00Z' }];
  assert.strictEqual(analyze({ ...base, comments: healthy, botMarked: (id) => id === 1 }).length, 0, 'healthy channel stays quiet');
  assert.strictEqual(analyze({ ...base, comments: [c(7, '**Planner → Frontend:** /ask x', 30)], closed: () => true }).length, 0, 'closed issue ignored');
  assert.strictEqual(analyze({ ...base, comments: [], workflowState: 'disabled_manually' }).length, 1, 'disabled workflow fires');
  assert.strictEqual(analyze({ ...base, comments: [{ ...c(8, '**Planner → Frontend:** /ask x', 30), html_url: 'https://github.com/octo/ch/pull/9#issuecomment-8' }] }).length, 0, 'PR comment ignored');
  assert.strictEqual(main(['--repo', 'o/r', '--grace', 'soon']), 2, 'bad grace is rejected');
  assert.strictEqual(main(['--repo', 'o/r', '--config', path.join(__dirname, 'no-such-config.json')]), 3, 'missing config = could not check');
  console.log('check-relay self-test OK (fires on unprocessed/foreign-marked/disabled; quiet on healthy/closed/old/other-account; 2 and 3 exits)');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { analyze };
