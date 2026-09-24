// issue-relay router — runs inside a GitHub Action on every issue comment.
//
// A comment whose FIRST line is
//     **<Author> → <Target>:** /ask | /handoff | /return  ...
// moves the issue's labels so the target agent's loop picks it up. That is all it does:
// the router never calls a model and never comments (a bot comment would become the
// "last comment" every consumer looks at, and wake them all up).
//
// State lives on the comment itself: the bot reacts 👀 (in progress), 🚀 (applied) or
// 😕 (rejected). Every run drains ALL unmarked commands of the issue in id order, so
// re-running a job is a no-op and a failed run is picked up by the next one.
// Spend limits are NOT here: they live in each consumer (brake/agent-brake.js).
//
// Usage:  node router.js              (in Actions: GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER)
//         node router.js --self-test
'use strict';
const fs = require('fs');
const path = require('path');

const BOT = 'github-actions[bot]';
const BOM = String.fromCharCode(0xfeff);
const CMD_RE = /^\s*\*\*([\p{L}\p{M}\d-]+)\s*(?:→|->)\s*([\p{L}\p{M}\d-]+):\*\*\s*\/(ask|handoff|return)(?=\s|$)/iu;
const norm = (s) => String(s).normalize('NFC').toLowerCase();

// Loads and validates the config. Fails loudly on anything ambiguous: a bad config must not
// silently route (or brake) differently from what the operator thinks.
function loadConfig(file = path.join(__dirname, 'config.json')) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!c.agents || typeof c.agents !== 'object' || Array.isArray(c.agents)) throw new Error('config: "agents" must be an object');
  const strings = (v, what) => { if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new Error(`config: ${what} must be an array of strings`); return v || []; };
  const alias = Object.create(null);
  for (const [agent, aliases] of Object.entries(c.agents)) {
    for (const name of [agent, ...strings(aliases, `aliases of "${agent}"`)]) {
      const k = norm(name);
      if (!/^[\p{L}\p{M}\d-]+$/u.test(k)) throw new Error(`config: invalid agent name "${name}"`);
      if (k in alias) throw new Error(`config: "${name}" is declared twice`);
      alias[k] = norm(agent);
    }
  }
  const humans = new Set(strings(c.humans, '"humans"').map(norm));
  for (const h of humans) {
    if (!/^[\p{L}\p{M}\d-]+$/u.test(h)) throw new Error(`config: invalid human name "${h}"`);
    if (h in alias) throw new Error(`config: "${h}" is both a human and an agent`);
  }
  const validator = alias[norm(c.validator || '')];
  if (!validator) throw new Error(`config: validator "${c.validator}" is not an agent`);
  if (!c.activation || Number.isNaN(Date.parse(c.activation))) throw new Error('config: "activation" must be an ISO date');
  const labels = { prefix: 'to:', review: 'review', brake: 'agents:brake', ...(c.labels || {}) };
  for (const [k, v] of Object.entries(labels)) {
    if (typeof v !== 'string' || !v.trim() || /[\r\n|,]/.test(v)) throw new Error(`config: label "${k}" must be a non-empty string without , | or newlines`);
  }
  if (c.poster !== undefined && (typeof c.poster !== 'string' || !c.poster)) throw new Error('config: "poster" must be a GitHub login');
  if (new Set([labels.review, labels.brake]).size < 2 || [labels.review, labels.brake].some((l) => l.startsWith(labels.prefix))) {
    throw new Error('config: review and brake labels must differ from each other and from the agent prefix');
  }
  return { ...c, alias, humans, validator, labels };
}

// {author, target, cmd} or null when the first line is not a valid command.
function parse(body, cfg) {
  const m = CMD_RE.exec(String(body || '').replace(BOM, '').split(/\r?\n/, 1)[0]);
  if (!m) return null;
  const a = norm(m[1]), t = norm(m[2]);
  const author = cfg.alias[a] || (cfg.humans.has(a) ? a : null);
  const target = cfg.alias[t];
  if (!author || !target || author === target) return null;
  return { author, target, cmd: m[3].toLowerCase() };
}

// Transition computed on the issue's CURRENT state: {add, remove} or {reject}.
function decide(c, issue, cfg) {
  const L = cfg.labels, labels = issue.labels, to = L.prefix + c.target;
  if (issue.state !== 'open') return { reject: 'issue is closed' };
  if (labels.includes(L.brake)) return { reject: `${L.brake} is set (only a human removes it)` };
  // handoff and return pass the ball: the author drops out of its own queue.
  const fromAuthor = cfg.alias[c.author] && labels.includes(L.prefix + c.author) ? [L.prefix + c.author] : [];
  if (c.cmd === 'handoff') {
    if (c.target !== cfg.validator) return { reject: `handoff only goes to the validator (${cfg.validator})` };
    return { add: [to, L.review], remove: fromAuthor };
  }
  if (c.cmd === 'return') {
    if (c.author !== cfg.validator && !cfg.humans.has(c.author)) return { reject: `only the validator (${cfg.validator}) or a human can /return` };
    if (c.target === cfg.validator) return { reject: '/return goes from the validator to another agent' };
    // The ball leaves the validator even when a human sends it back.
    const fromValidator = labels.includes(L.prefix + cfg.validator) ? [L.prefix + cfg.validator] : [];
    return { add: [to], remove: [...(labels.includes(L.review) ? [L.review] : []), ...fromValidator] };
  }
  if (labels.includes(L.review) && c.target !== cfg.validator) return { reject: `issue is in ${L.review}: use /return` };
  return { add: [to], remove: [] }; // ask: additive, whoever asks keeps the ticket
}

// Drains the pending commands of issue n in order. api(method, path, body) -> JSON.
async function processIssue(api, n, owner, cfg, log = console.log) {
  const comments = [];
  for (let p = 1; ; p++) {
    const page = await api('GET', `/issues/${n}/comments?per_page=100&page=${p}`);
    comments.push(...page);
    if (page.length < 100) break;
  }
  const cmds = comments
    .filter((k) => k.user.login === (cfg.poster || owner) && Date.parse(k.created_at) > Date.parse(cfg.activation) && parse(k.body, cfg))
    .sort((a, b) => a.id - b.id);
  const marks = async (id) => { // bot reactions on the comment, paginated
    const s = new Set();
    for (let p = 1; ; p++) {
      const page = await api('GET', `/issues/comments/${id}/reactions?per_page=100&page=${p}`);
      for (const r of page) if (r.user.login === BOT) s.add(r.content);
      if (page.length < 100) return s;
    }
  };
  const mark = (id, content) => api('POST', `/issues/comments/${id}/reactions`, { content });
  let applied = 0;
  for (const k of cmds) {
    const m = await marks(k.id);
    if (m.has('rocket') || m.has('confused')) continue;
    const c = parse(k.body, cfg);
    if (m.has('eyes')) { // a previous run started this transition and never finished: do not re-apply blindly
      log(`::error::#${n} comment ${k.id} /${c.cmd} ${c.author}→${c.target} was left half-applied: check the labels by hand`);
      await mark(k.id, 'confused');
      process.exitCode = 1;
      continue;
    }
    const iss = await api('GET', `/issues/${n}`); // re-read before every transition
    const d = decide(c, { state: iss.state, labels: iss.labels.map((l) => l.name) }, cfg);
    if (d.reject) {
      log(`::warning::#${n} comment ${k.id} /${c.cmd} ${c.author}→${c.target} rejected: ${d.reject}`);
      await mark(k.id, 'confused');
      continue;
    }
    await mark(k.id, 'eyes');
    if (d.add.length) await api('POST', `/issues/${n}/labels`, { labels: d.add });
    for (const l of d.remove) await api('DELETE', `/issues/${n}/labels/${encodeURIComponent(l)}`);
    await mark(k.id, 'rocket');
    log(`#${n} comment ${k.id} /${c.cmd} ${c.author}→${c.target}: +[${d.add}] -[${d.remove}]`);
    applied++;
  }
  return applied;
}

async function main() {
  const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  const api = async (method, p, body) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${p}`, { method, body: body && JSON.stringify(body),
      headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } });
    if (method === 'DELETE' && r.status === 404) return null; // label was already gone
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
  await processIssue(api, ev.issue.number, process.env.GITHUB_REPOSITORY_OWNER, loadConfig());
}

// In-memory fake GitHub to test sequences.
function fakeGithub(labels, owner = 'octo') {
  const st = { state: 'open', labels: [...labels], comments: [], reactions: {}, mutations: 0 };
  let id = 100;
  st.say = (body, user = owner, created_at = '2030-01-02T00:00:00Z') => st.comments.push({ id: ++id, body, user: { login: user }, created_at });
  st.api = async (method, p, body) => {
    let m;
    if (method === 'GET' && (m = /^\/issues\/\d+\/comments\?per_page=100&page=(\d+)$/.exec(p))) return st.comments.slice((m[1] - 1) * 100, m[1] * 100);
    if (method === 'GET' && /^\/issues\/\d+$/.test(p)) return { state: st.state, labels: st.labels.map((name) => ({ name })) };
    if ((m = /^\/issues\/comments\/(\d+)\/reactions/.exec(p))) {
      if (method === 'GET') { const pg = +/&page=(\d+)/.exec(p)[1]; return (st.reactions[m[1]] || []).slice((pg - 1) * 100, pg * 100); }
      (st.reactions[m[1]] = st.reactions[m[1]] || []).push({ content: body.content, user: { login: BOT } }); return {};
    }
    st.mutations++;
    if (method === 'POST') { for (const l of body.labels) if (!st.labels.includes(l)) st.labels.push(l); return []; }
    if (method === 'DELETE') { st.labels = st.labels.filter((l) => l !== decodeURIComponent(p.split('/').pop())); return null; }
    throw new Error('fake: ' + method + ' ' + p);
  };
  return st;
}

async function selfTest() {
  const assert = require('assert');
  const cfg = loadConfig(path.join(__dirname, 'config.example.json'));
  const ok = (b, exp) => assert.deepStrictEqual(parse(b, cfg), exp, JSON.stringify(b));
  ok('**Planner → Frontend:** /ask check the landing', { author: 'planner', target: 'frontend', cmd: 'ask' });
  ok(BOM + '**Frontend-1 -> Planner:** /handoff done', { author: 'frontend', target: 'planner', cmd: 'handoff' });
  ok('**Planner → Infra:** /return missing the backup', { author: 'planner', target: 'infra', cmd: 'return' });
  ok('**Owner → Infra:** /ask\nrestart it', { author: 'owner', target: 'infra', cmd: 'ask' });
  ok('**Planner → Diseño:** /ask x', { author: 'planner', target: 'design', cmd: 'ask' }); // non-ASCII alias
  for (const bad of [
    '**Planner:** old example: **Infra → Frontend:** /ask x', 'hi\n**Planner → Frontend:** /ask x',
    '**PlannerBot → Frontend:** /ask x', '**Planner → Frontend-3:** /ask x', '**Planner → Owner:** /ask x',
    '**Planner → Planner:** /ask x', '**Planner → Frontend:** /asks x', '**Planner → Frontend:** ask x',
    '**Assistant:** /ask infra', '**[Frontend] → Planner:** /handoff', '',
  ]) ok(bad, null);

  const quiet = () => {};
  const sorted = (s) => [...s.labels].sort();
  const run = (g) => processIssue(g.api, 1, 'octo', cfg, quiet);
  // return then ask while in review: both applied, in order
  let g = fakeGithub(['to:planner', 'review']);
  g.say('**Planner → Frontend:** /return missing test'); g.say('**Planner → Infra:** /ask read the log');
  assert.strictEqual(await run(g), 2);
  assert.deepStrictEqual(sorted(g), ['to:frontend', 'to:infra']);
  // re-run after a manual change: touches nothing
  g.labels.push('review'); const before = g.mutations;
  assert.strictEqual(await run(g), 0); assert.strictEqual(g.mutations, before);
  // handoff to the validator: review + the ball moves
  g = fakeGithub(['to:frontend']); g.say('**Frontend-2 → Planner:** /handoff done'); await run(g);
  assert.deepStrictEqual(sorted(g), ['review', 'to:planner']);
  // /return by a human: the validator's label goes too
  g = fakeGithub(['to:planner', 'review']); g.say('**Owner → Frontend:** /return redo it');
  assert.strictEqual(await run(g), 1); assert.deepStrictEqual(sorted(g), ['to:frontend']);
  // /return to the validator itself: rejected
  g = fakeGithub(['to:planner', 'review']); g.say('**Owner → Planner:** /return x'); assert.strictEqual(await run(g), 0);
  // activation with an offset compares as a date, not as text
  const cfgOff = { ...cfg, activation: '2030-01-02T03:00:00+05:00' }; // = 2030-01-01T22:00Z, before the comment
  g = fakeGithub([]); g.say('**Planner → Frontend:** /ask x'); assert.strictEqual(await processIssue(g.api, 1, 'octo', cfgOff, quiet), 1);
  // poster account (organizations): only that login counts
  g = fakeGithub([], 'bot-user'); g.say('**Planner → Frontend:** /ask x');
  assert.strictEqual(await processIssue(g.api, 1, 'the-org', { ...cfg, poster: 'bot-user' }, quiet), 1);
  // /return from a non-validator agent: rejected, review stays
  g = fakeGithub(['to:frontend', 'review']); g.say('**Frontend → Infra:** /return nope');
  assert.strictEqual(await run(g), 0); assert.deepStrictEqual(sorted(g), ['review', 'to:frontend']);
  // config validation: duplicate alias, unknown validator, human that is also an agent
  const tmp = path.join(require('os').tmpdir(), 'relay-cfg-test.json');
  for (const bad of [
    { agents: { a: ['x'], b: ['x'] }, validator: 'a', activation: '2030-01-01T00:00:00Z' },
    { agents: { a: [] }, validator: 'zz', activation: '2030-01-01T00:00:00Z' },
    { agents: { a: [] }, humans: ['a'], validator: 'a', activation: '2030-01-01T00:00:00Z' },
    { agents: { a: [] }, validator: 'a', activation: 'soon' },
    { agents: { a: 'xy' }, validator: 'a', activation: '2030-01-01T00:00:00Z' },
    { agents: [], validator: 'a', activation: '2030-01-01T00:00:00Z' },
    { agents: { a: [] }, validator: 'a', activation: '2030-01-01T00:00:00Z', labels: { review: 'a|b' } },
    { agents: { a: [] }, humans: ['bad name'], validator: 'a', activation: '2030-01-01T00:00:00Z' },
  ]) { fs.writeFileSync(tmp, JSON.stringify(bad)); assert.throws(() => loadConfig(tmp)); }
  fs.writeFileSync(tmp, JSON.stringify({ agents: { Lead: ['constructor'] }, validator: 'LEAD', activation: '2030-01-01T00:00:00Z' }));
  assert.strictEqual(loadConfig(tmp).validator, 'lead'); // validator normalized to the canonical agent
  // combining marks (NFD input) resolve to the same alias
  ok('**Planner → Disen' + String.fromCharCode(0x0303) + 'o:** /ask x', { author: 'planner', target: 'design', cmd: 'ask' });
  // handoff to a non-validator: rejected and marked, never retried
  g = fakeGithub(['to:frontend']); g.say('**Frontend → Infra:** /handoff done');
  assert.strictEqual(await run(g), 0); assert.deepStrictEqual(sorted(g), ['to:frontend']);
  assert.strictEqual(g.reactions[g.comments[0].id][0].content, 'confused');
  // brake: rejected; removing the brake later does not revive the old command
  g = fakeGithub(['to:planner', 'agents:brake']); g.say('**Planner → Infra:** /ask x'); await run(g);
  g.labels = ['to:planner']; assert.strictEqual(await run(g), 0); assert.deepStrictEqual(sorted(g), ['to:planner']);
  // ask on an issue in review to a non-validator: rejected
  g = fakeGithub(['review']); g.say('**Planner → Frontend:** /ask x'); assert.strictEqual(await run(g), 0);
  // closed: rejected
  g = fakeGithub(['to:planner']); g.state = 'closed'; g.say('**Planner → Frontend:** /ask x'); assert.strictEqual(await run(g), 0);
  // ignored and unmarked: another account, before activation, plain comment
  g = fakeGithub([]);
  g.say('**Planner → Frontend:** /ask x', 'someone-else');
  g.say('**Planner → Frontend:** /ask x', 'octo', '2020-01-01T00:00:00Z');
  g.say('**Planner:** thanks');
  assert.strictEqual(await run(g), 0); assert.deepStrictEqual(g.labels, []); assert.deepStrictEqual(g.reactions, {});
  // burst on page 2, shuffled
  g = fakeGithub([]);
  for (let i = 0; i < 147; i++) g.say('chat ' + i);
  g.say('**Owner → Infra:** /ask a'); g.say('**Owner → Assistant:** /ask b'); g.say('**Planner → Frontend:** /ask c'); g.say('**Planner → Frontend:** /return d');
  g.comments.splice(147, 4, ...g.comments.slice(147).reverse());
  assert.strictEqual(await run(g), 4);
  assert.deepStrictEqual(sorted(g), ['to:assistant', 'to:frontend', 'to:infra']);
  assert.strictEqual(await run(g), 0);
  // order matters: return (drops review) before ask to infra
  g = fakeGithub(['to:planner', 'review']); g.say('**Planner → Frontend:** /return a'); g.say('**Planner → Infra:** /ask b');
  g.comments.reverse(); assert.strictEqual(await run(g), 2);
  // failure before starting a command: next run picks it up
  g = fakeGithub([]); g.say('**Planner → Frontend:** /ask a'); g.say('**Planner → Infra:** /ask b');
  let real = g.api, fail = true;
  g.api = async (mt, p, b) => { if (fail && mt === 'GET' && p === `/issues/comments/${g.comments[1].id}/reactions?per_page=100&page=1`) { fail = false; throw new Error('500'); } return real(mt, p, b); };
  await assert.rejects(run(g)); assert.strictEqual(await run(g), 1); assert.deepStrictEqual(sorted(g), ['to:frontend', 'to:infra']);
  // failure halfway through a transition: not re-applied, marked 😕, job red, next command still processed
  g = fakeGithub(['to:frontend']); g.say('**Frontend → Planner:** /handoff done'); g.say('**Owner → Infra:** /ask x');
  real = g.api; fail = true;
  g.api = async (mt, p, b) => { if (fail && mt === 'DELETE') { fail = false; throw new Error('500'); } return real(mt, p, b); };
  await assert.rejects(run(g));
  g.labels = ['to:planner'];
  assert.strictEqual(await run(g), 1); assert.strictEqual(process.exitCode, 1); process.exitCode = 0;
  assert.deepStrictEqual(sorted(g), ['to:infra', 'to:planner']);
  // paginated reactions: 100 foreign reactions before the bot's mark
  g = fakeGithub([]); g.say('**Planner → Frontend:** /ask a'); assert.strictEqual(await run(g), 1);
  g.reactions[g.comments[0].id].unshift(...Array.from({ length: 100 }, () => ({ content: '+1', user: { login: 'octo' } })));
  g.labels = []; assert.strictEqual(await run(g), 0); assert.deepStrictEqual(g.labels, []);
  // state re-read: a human sets the brake between two commands, the second is rejected
  g = fakeGithub([]); g.say('**Planner → Frontend:** /ask a'); g.say('**Planner → Infra:** /ask b');
  const real2 = g.api;
  g.api = async (mt, p, b) => { const r = await real2(mt, p, b); if (b && b.content === 'rocket') g.labels.push('agents:brake'); return r; };
  assert.strictEqual(await run(g), 1); assert.ok(!g.labels.includes('to:infra'));
  console.log('router self-test OK');
}

if (process.argv.includes('--self-test')) selfTest().catch((e) => { console.error(e); process.exit(1); });
else if (require.main === module) main().catch((e) => { console.error('::error::' + e.message); process.exit(1); });

module.exports = { parse, decide, processIssue, loadConfig };
