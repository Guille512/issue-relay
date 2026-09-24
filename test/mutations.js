// Mutation test: every mutation of the router or the brake MUST turn its self-test red.
// A green self-test only means something if a broken version would have been caught.
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const B = String.fromCharCode(92);
const ROUTER = path.join(__dirname, '../template/.github/relay/router.js');
const BRAKE = path.join(__dirname, '../brake/agent-brake.js');
const mutations = [
  [ROUTER, 'unanchored command regex', '/^' + B + 's*' + B + '*' + B + '*(', '/' + B + 's*' + B + '*' + B + '*('],
  [ROUTER, 'no closed check', "if (issue.state !== 'open')", 'if (false)'],
  [ROUTER, 'no brake check', 'if (labels.includes(L.brake))', 'if (false)'],
  [ROUTER, 'handoff to anyone', 'if (c.target !== cfg.validator) return { reject: `handoff', 'if (false) return { reject: `handoff'],
  [ROUTER, 'handoff keeps the ball', 'return { add: [to, L.review], remove: fromAuthor }', 'return { add: [to, L.review], remove: [] }'],
  [ROUTER, 'ask drops review', 'if (labels.includes(L.review) && c.target !== cfg.validator) return', 'if (false) return'],
  [ROUTER, 'unknown author accepted', 'if (!author ||', 'if ('],
  [ROUTER, 'no word boundary after command', '(?=' + B + 's|$)', ''],
  [ROUTER, 'applied not marked', "await mark(k.id, 'rocket');", ''],
  [ROUTER, 'in-progress not marked', "await mark(k.id, 'eyes');", ''],
  [ROUTER, 'half-applied re-applied', "if (m.has('eyes')) {", 'if (false) {'],
  [ROUTER, 'reactions not paginated', 'if (page.length < 100) return s;', 'return s;'],
  [ROUTER, 'no owner filter', 'k.user.login === (cfg.poster || owner) &&', ''],
  [ROUTER, 'no activation filter', 'Date.parse(k.created_at) > Date.parse(cfg.activation) &&', ''],
  [ROUTER, 'activation compared as text', 'Date.parse(k.created_at) > Date.parse(cfg.activation)', 'k.created_at > cfg.activation'],
  [ROUTER, 'human /return keeps validator label', "const fromValidator = labels.includes(L.prefix + cfg.validator) ? [L.prefix + cfg.validator] : [];", 'const fromValidator = [];'],
  [ROUTER, 'poster ignored', 'k.user.login === (cfg.poster || owner)', 'k.user.login === owner'],
  [BRAKE, 'state shape not validated', 'validState(state); } catch', '} catch'],
  [ROUTER, 'no id ordering', '.sort((a, b) => a.id - b.id)', ''],
  [ROUTER, 'comments not paginated', 'if (page.length < 100) break;', 'break;'],
  [ROUTER, 'stale state', "const iss = await api('GET', `/issues/${n}`); // re-read", "const iss = cmds.__i || (cmds.__i = await api('GET', `/issues/${n}`)); // re-read"],
  [ROUTER, 'anyone can /return', 'if (c.author !== cfg.validator && !cfg.humans.has(c.author)) return', 'if (false) return'],
  [ROUTER, '/return to the validator accepted', "if (c.target === cfg.validator) return { reject: '/return", "if (false) return { reject: '/return"],
  [ROUTER, 'duplicate alias accepted', 'if (k in alias) throw', 'if (false) throw'],
  [ROUTER, 'no NFC normalization', "const norm = (s) => String(s).normalize('NFC').toLowerCase();", 'const norm = (s) => String(s).toLowerCase();'],
  [BRAKE, 'label ignored', 'if (labels.includes(lim.label)) return', 'if (false) return'],
  [BRAKE, 'no budget', 'if (uses.length >= lim.max24h)', 'if (false)'],
  [BRAKE, 'same comment forever', '&& st.same >= lim.maxSame', '&& false'],
  [BRAKE, 'pendingBrake ignored', 'if (st.pendingBrake) return', 'if (false) return'],
  [BRAKE, 'window never rolls', 'const uses = st.uses.filter((t) => nowMs - t < DAY_MS);', 'const uses = st.uses;'],
];
let bad = 0;
for (const [file, name, from, to] of mutations) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) { console.log('DOES NOT APPLY ', name); bad++; continue; }
  const mut = path.join(path.dirname(file), '.mutant.js');
  fs.writeFileSync(mut, src.replace(from, to));
  const r = spawnSync(process.execPath, [mut, '--self-test'], { encoding: 'utf8' });
  fs.rmSync(mut, { force: true });
  console.log(r.status ? 'red (good)     ' : 'GREEN (bad)    ', path.basename(file), '·', name);
  if (!r.status) bad++;
}
console.log(bad ? `\n${bad} mutation(s) survived` : `\nall ${mutations.length} mutations caught`);
process.exit(bad ? 1 : 0);
