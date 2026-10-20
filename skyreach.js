/* Skyreach — free-play demo. Play points only: nothing here can be bought with real money,
   cashed out, or traded for prizes. All state lives in this browser's localStorage. */
(() => {
'use strict';

// ======================= Constants (all shown on the Help screen) =======================
const KEY = 'skyreach.v1';
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const params = new URLSearchParams(location.search);
const FORCE_SIM = params.get('sim') === '1';
const OFFLINE_CAP = 12 * HOUR;
const MAX_LEVEL = 10;
const BUILDERS = 2;
const NEXT_SLOTS = 1; // build queue: ONE extra upgrade can be lined up on top of the builders (paid when it starts)
const RES = ['grain', 'timber', 'ore'];
const BUILDINGS = {
  farm:     { name: 'Grain Farm',     makes: 'grain',  what: 'Makes Grain.' },
  mill:     { name: 'Timber Mill',    makes: 'timber', what: 'Makes Timber.' },
  mine:     { name: 'Ore Mine',       makes: 'ore',    what: 'Makes Ore.' },
  barracks: { name: 'Barracks',       what: 'Trains troops. Level 4 unlocks tier 2, level 7 unlocks tier 3.' },
  tower:    { name: 'Tidecaller Tower', what: 'Gives free Forecast calls each day (3 + tower level).' },
  infirmary: { name: 'Infirmary', what: 'Holds wounded troops and heals them over time. Higher level holds and heals more.' },
};
const BKEYS = Object.keys(BUILDINGS);
// (Old one-building rule, unused now: the Spire needs every building at its level.)
const PREREQ = ['farm', 'mill', 'mine', 'barracks', 'tower'];
const prereqFor = (target) => PREREQ[(target - 2) % 5];
// Curve C (Da Angel's simulator, Oct 18): hardcore ~5.7 days, once-a-day casual ~19.2 days to level 10.
// Upgrade timers from level L to L+1 (index L-1), normal speed. Max is 20 hours (Spire 9 to 10).
const B_TIME = [10e3, 30e3, MIN, 30 * MIN, 55 * MIN, 100 * MIN, 3 * HOUR, 5.5 * HOUR, 10 * HOUR];
const S_TIME = [20e3, 45e3, 90e3, 45 * MIN, 90 * MIN, 3 * HOUR, 5.5 * HOUR, 10.5 * HOUR, 20 * HOUR];
const B_COST = [120, 216, 389, 700, 2600, 80000, 230000, 420000, 810000];
const S_COST = [220, 407, 753, 1400, 5400, 170000, 480000, 930000, 1800000];
const bCost = (L) => B_COST[L - 1];
const sCost = (L) => S_COST[L - 1];
// Daily gift and wipe starter keep the old formula so one gift never pays for a whole level.
const giftAmt = (L) => Math.round(220 * Math.pow(1.85, L - 1));

const TROOPS = {
  // Fixed counter triangle: Cavalry beats Infantry, Infantry beats Archers, Archers beat Cavalry.
  inf: { name: 'Infantry', beats: 'rng', short: 'Infantry' },
  cav: { name: 'Cavalry',  beats: 'inf', short: 'Cavalry' },
  rng: { name: 'Archers',  beats: 'cav', short: 'Archers' },
};
const TKEYS = ['inf', 'cav', 'rng'];
const T_POWER = [10, 25, 55];
const T_COST = [{ grain: 15, timber: 5, ore: 5 }, { grain: 35, timber: 15, ore: 15 }, { grain: 80, timber: 35, ore: 40 }];
const T_SEC = [1e3, 2e3, 4e3];
const TIER_UNLOCK = [1, 4, 7];

const MONSTER_KINDS = [
  { name: 'Shell Crab',   like: 'inf', note: 'Hard shell. Fights like Infantry.' },
  { name: 'Tide Serpent', like: 'cav', note: 'Fast. Fights like Cavalry.' },
  { name: 'Spitter Ray',  like: 'rng', note: 'Spits from far. Fights like Archers.' },
];
const monster = (lvl) => {
  const kind = MONSTER_KINDS[(lvl - 1) % 3];
  return { lvl, kind, power: Math.round(120 * Math.pow(1.85, lvl - 1)), loot: Math.round(250 * Math.pow(1.75, lvl - 1)),
    gems: Math.floor(lvl / 3), shards: lvl };
};
const MONSTER_RESPAWN = 20 * MIN;

const RIVALS = [
  { id: 'brine',   name: 'Captain Brine', mult: 0.7, banner: 'Saltfang' },
  { id: 'vela',    name: 'Vela Stormcut', mult: 0.9, banner: 'Saltfang' },
  { id: 'harrow',  name: 'Old Harrow',    mult: 1.1, banner: 'Grey Gulls' },
  { id: 'kestrel', name: 'Kestrel',       mult: 1.3, banner: 'Grey Gulls' },
  { id: 'marrow',  name: 'Marrow Jack',   mult: 1.6, banner: 'Black Reef' },
  { id: 'isolde',  name: 'Isolde Gale',   mult: 2.2, banner: 'Black Reef' },
];
function rivalFactor(r, t = Date.now()) { const st = S.rivals[r.id]; return st && st.weakUntil > t ? st.weakMult : 1; }
const rivalAttack = (r, L, t) => Math.round(260 * Math.pow(1.8, L - 1) * r.mult * rivalFactor(r, t));
// AI rivals take wounded/killed too. Troop count = power / 20 (their average troop).
function rivalLosses(r, power, frac, role, t, won) {
  const n = Math.round(power / 20 * frac), w = Math.round(n * WOUND_SHARE[role]), healed = won ? Math.round(w * 0.1) : 0;
  const st = S.rivals[r.id] = S.rivals[r.id] || {};
  st.wounded = (st.wounded || 0) + w - healed; st.killed = (st.killed || 0) + n - w;
  return { wounded: w - healed, killed: n - w, healed };
}
const rivalDefense = (r, L, t) => Math.round(rivalAttack(r, L, t) * 0.8);
const wallDefense = (L) => Math.round(150 * Math.pow(1.8, L - 1));
const RAID_EVERY = 2 * HOUR;
const REPAIR_TIME = 30 * MIN;
const START_SHIELD = 4 * HOUR;
const SHIELD_DAILY = 2 * HOUR, SHIELD_FORECAST = 30 * MIN, SHIELD_LEVELUP = 1 * HOUR;
// Lose a raid (or get wiped) = automatic 8-hour shield. It is never blocked, but it counts toward the cap.
const SHIELD_AFTER_LOSS = 8 * HOUR;
// Max 1 new shield per 8 hours for everyone, from any source (daily gift, Forecast win, level-up, Gems).
const SHIELD_CAP_WINDOW = 8 * HOUR;
// Finish-now price: 1 Gem per 3 minutes for the first hour left, then 1 Gem per 2 minutes beyond an hour.
const FINISH_MIN_PER_GEM = 3, FINISH_MIN_PER_GEM_LONG = 2;
const COMEBACK_TIME = 1 * HOUR, COMEBACK_MULT = 3;

const PERKS = {
  grain:   { name: '+20% Grain',            desc: 'Farms make 20% more.' },
  timber:  { name: '+20% Timber',           desc: 'Mills make 20% more.' },
  ore:     { name: '+20% Ore',              desc: 'Mines make 20% more.' },
  build:   { name: '15% faster building',   desc: 'Upgrades take 15% less time.' },
  army:    { name: '+10% all troops',       desc: 'Every troop fights 10% harder.' },
  inf:     { name: '+20% Infantry',         desc: 'Infantry fight 20% harder.' },
  cav:     { name: '+20% Cavalry',          desc: 'Cavalry fight 20% harder.' },
  rng:     { name: '+20% Archers',          desc: 'Archers fight 20% harder.' },
  wall:    { name: '+25% Spire wall',       desc: 'Your Spire wall defends 25% better.' },
  cheap:   { name: '15% cheaper troops',    desc: 'Troops cost 15% less.' },
  calls:   { name: '+2 Forecast calls',     desc: '2 more free Forecast calls each day.' },
  loot:    { name: '+25% monster loot',     desc: 'Sea monsters drop 25% more.' },
  shield:  { name: 'Longer shields',        desc: 'Shields you earn last 25% longer.' },
};
const PKEYS = Object.keys(PERKS);
// Original factions (Rome-meets-fantasy). Bonuses are small and shown on the pick screen.
const FACTIONS = {
  aurelian: { name: 'Aurelian Republic', region: 'Valeria Heights', icon: '🏛️',
    desc: 'Disciplined citizen legions from the marble hill-cities. Steady, hard to break.',
    unit: 'Testudo Legion: your Infantry fight 25% harder.', bonus: { inf: 0.25, wall: 0.10 }, extra: 'Spire wall +10%.' },
  sunfire: { name: 'Sunfire Dominion', region: 'Kesh Sands', icon: '☀️',
    desc: 'A desert empire of bronze domes and fast riders across the dunes.',
    unit: 'Dune Lancers: your Cavalry fight 25% harder.', bonus: { cav: 0.25, ore: 0.10 }, extra: 'Ore +10%.' },
  frostmark: { name: 'Frostmark Clans', region: 'Hrafn Fells', icon: '🐺',
    desc: 'Northern tribes of pine and snow. Sharp eyes, bold hunters.',
    unit: 'Ravenbow Hunters: your Archers fight 25% harder.', bonus: { rng: 0.25, loot: 0.15 }, extra: 'Sea-monster loot +15%.' },
};
const fBonus = (k) => (S.faction && FACTIONS[S.faction].bonus[k]) || 0;

// ======================= Helpers =======================
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtUSD = (n) => n == null ? '…' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtClock = (ms, secs) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: secs ? '2-digit' : undefined });
function fmtDur(ms) {
  ms = Math.max(0, ms); const s = Math.ceil(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
const today = () => new Date().toLocaleDateString('en-CA');
function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ======================= State =======================
function freshState() {
  const now = Date.now();
  return {
    v: 1, created: now, last: now, fast: false, name: 'Joney', faction: null, seed: Math.floor(Math.random() * 1e9),
    res: { grain: 800, timber: 800, ore: 800 }, gems: 20, shards: 0,
    b: { spire: 1, farm: 1, mill: 1, mine: 1, barracks: 1, tower: 1, infirmary: 1 },
    wounded: { inf: [0, 0, 0], cav: [0, 0, 0], rng: [0, 0, 0] }, healAcc: 0, healedTotal: 0,
    queue: [], nextUp: null, train: null, // nextUp: {key, to, at} = the one lined-up upgrade (not paid yet)
    army: { inf: [10, 0, 0], cav: [10, 0, 0], rng: [10, 0, 0] },
    perks: [], perkChoices: [],
    shieldUntil: now + START_SHIELD, lastShieldAt: now, repairUntil: 0, // the start shield counts as your 8-hour shield (same as the simulator)
    boost: null, // {until, mult, why}
    raid: { next: now + RAID_EVERY, idx: 0 },
    revenge: [], raidLog: [],
    monsters: {},
    fc: { day: today(), used: 0, earned: { grain: 0, timber: 0, ore: 0 }, calls: [], rounds: {}, spreadKept: 0 },
    daily: { gift: '', adsDay: '', ads: 0, gifts: 0 },
    pass: { xp: 0, premium: false, claimed: [] },
    cos: { owned: [], theme: '' },
    chat: null,
    tele: { tokens: 2, cooldownUntil: 0, near: null, alertUntil: 0, surpriseUntil: 0 }, rivals: {},
    stats: { wipes: 0, raidsHeld: 0, raidsLost: 0, revengeWins: 0 },
  };
}
// Old saves (same key) get any missing fields filled with defaults. Nothing already saved is changed.
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
function migrate(s) {
  const d = freshState(), hadLastShield = typeof s.lastShieldAt === 'number';
  for (const k of Object.keys(d)) {
    if (s[k] === undefined) s[k] = d[k];
    else if (isObj(d[k]) && isObj(s[k])) for (const kk of Object.keys(d[k])) if (s[k][kk] === undefined) s[k][kk] = d[k][kk];
  }
  if (!Array.isArray(s.queue)) s.queue = [];
  if (!isObj(s.nextUp) || !(BUILDINGS[s.nextUp.key] || s.nextUp.key === 'spire') || typeof s.nextUp.to !== 'number') s.nextUp = null;
  if (!hadLastShield) s.lastShieldAt = 0; // old save: no shield on record, so nothing is blocked
  return s;
}
function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) return migrate(s); } catch (e) { /* ignore */ }
  return freshState();
}
let S = load();
if (params.get('fast') === '1') S.fast = true;
if (params.get('fast') === '0') S.fast = false;
if (!S.faction && S.fast) { S.shieldUntil = Date.now() + Math.round(START_SHIELD / 60); S.raid.next = Date.now() + Math.round(RAID_EVERY / 60); }
function save() { localStorage.setItem(KEY, JSON.stringify(S)); }
let version = 0; // bump when the screen needs a full redraw
const changed = () => { version++; };

// Fast demo mode: every timer is 60x shorter, production is 20x bigger.
const T = (ms) => S.fast ? Math.max(1000, Math.round(ms / 60)) : ms;
const PROD_MULT = () => S.fast ? 20 : 1;
const hasPerk = (k) => S.perks.filter((p) => p === k).length;

// ======================= Economy =======================
function boostMult(t = Date.now()) {
  let m = 1;
  if (S.b.spire < 4) m = 2; // new-player Tailwind
  if (S.boost && S.boost.until > t) m = Math.max(m, S.boost.mult);
  return m;
}
function boostText(t = Date.now()) {
  const parts = [];
  if (S.boost && S.boost.until > t) parts.push(`${S.boost.why}: ${S.boost.mult}x building speed and resources for ${fmtDur(S.boost.until - t)} more`);
  if (S.b.spire < 4) parts.push('New-player Tailwind: 2x building speed and resources until Spire level 4');
  return parts;
}
function prodPerHour(res, t = Date.now(), withBoost = true) {
  const bk = BKEYS.find((k) => BUILDINGS[k].makes === res);
  const L = S.b[bk];
  if (S.repairUntil > t) return 0;
  let r = 1200 * L * Math.pow(1.2, L) * (1 + 0.2 * hasPerk(res) + fBonus(res)) * PROD_MULT();
  if (withBoost) r *= boostMult(t);
  return r;
}
function canAfford(cost) { return RES.every((r) => (S.res[r] || 0) >= (cost[r] || 0)); }
function pay(cost) { RES.forEach((r) => { S.res[r] -= cost[r] || 0; }); }
function gain(obj) { RES.forEach((r) => { S.res[r] += obj[r] || 0; }); }
const each = (n) => ({ grain: n, timber: n, ore: n });
const bName = (key) => key === 'spire' ? 'Spire' : BUILDINGS[key].name;
const upCost = (key, L) => each(key === 'spire' ? sCost(L) : bCost(L));
function upTime(key, L, t = Date.now()) {
  const time = ((key === 'spire' ? S_TIME : B_TIME)[L - 1] || 0) * (1 - 0.15 * Math.min(3, hasPerk('build'))) / boostMult(t);
  return T(time);
}
// Level rules only (max level, Spire cap, Spire needs all 6 buildings), checked against the levels in lv.
function levelBlock(key, lv) {
  const L = lv[key];
  if (L >= MAX_LEVEL) return 'Max level reached.';
  if (key !== 'spire' && L >= lv.spire) return `Needs Spire level ${L + 1} first. No building can be higher than the Spire.`;
  if (key === 'spire') {
    const behind = BKEYS.filter((k) => lv[k] < L);
    if (behind.length) return `Needs every building at level ${L} first (still need: ${behind.map((k) => BUILDINGS[k].name).join(', ')}).`;
  }
  return '';
}
function upgradeInfo(key) {
  const L = S.b[key];
  const cost = upCost(key, L), time = upTime(key, L);
  const inQueue = S.queue.some((q) => q.key === key);
  let block = '';
  if (L >= MAX_LEVEL) block = 'Max level reached.';
  else if (inQueue) block = 'Already upgrading.';
  else block = levelBlock(key, S.b);
  if (!block && S.queue.length >= BUILDERS) block = 'Both builders are busy.';
  if (!block && !canAfford(cost)) block = 'Not enough resources yet.';
  return { L, cost, time, block };
}
function startUpgrade(key) {
  const u = upgradeInfo(key);
  if (u.block) return toast(u.block, 'bad');
  pay(u.cost);
  const now = Date.now();
  S.queue.push({ key, to: u.L + 1, start: now, end: now + u.time });
  addXP(10);
  toast(`Building ${bName(key)} to level ${u.L + 1}. Ready in ${fmtDur(u.time)}.`);
  save(); changed(); render();
}
// ---- Build queue: one extra upgrade lined up on top of the builders. Nothing is paid until it starts.
// Levels as they will be once the builds in progress finish.
function plannedLevels() { const v = { ...S.b }; S.queue.forEach((q) => { v[q.key] = Math.max(v[q.key], q.to); }); return v; }
function queueInfo(key) { // can this be lined up next?
  const v = plannedLevels(), L = v[key];
  const cost = upCost(key, Math.min(L, MAX_LEVEL - 1) || 1);
  let block = '';
  if (S.nextUp) block = 'You already have one upgrade lined up.';
  else if (S.queue.length < BUILDERS) block = 'A builder is free. Start it now instead.';
  else block = levelBlock(key, v);
  return { L, to: L + 1, cost, block };
}
function queueNext(key) {
  const qi = queueInfo(key);
  if (qi.block) return toast(qi.block, 'bad');
  S.nextUp = { key, to: qi.to, at: Date.now() };
  toast(`Lined up next: ${bName(key)} to level ${qi.to}. It starts by itself when a builder is free and you can pay ${costText(qi.cost)} at that moment.`, 'good');
  save(); changed(); render();
}
function cancelNext() {
  if (!S.nextUp) return;
  const n = S.nextUp; S.nextUp = null;
  toast(`Removed ${bName(n.key)} → level ${n.to} from the queue. Nothing was paid, so nothing is lost.`);
  save(); changed(); render();
}
// Why the lined-up upgrade has not started yet ('' = it can start now). drop = it no longer makes sense.
function nextUpStatus(t = Date.now()) {
  const n = S.nextUp; if (!n) return null;
  const L = S.b[n.key], cost = upCost(n.key, Math.min(L, MAX_LEVEL - 1) || 1), inProg = S.queue.some((q) => q.key === n.key);
  if (L >= n.to || L >= MAX_LEVEL) return { drop: true, why: `${bName(n.key)} is already level ${L}.`, cost };
  if (inProg) return { why: `Waiting for the current ${bName(n.key)} upgrade to finish.`, cost };
  if (L < n.to - 1) return { drop: true, why: `${bName(n.key)} is not at level ${n.to - 1} any more.`, cost };
  if (S.queue.length >= BUILDERS) return { why: 'Waiting for a free builder.', cost };
  const lb = levelBlock(n.key, S.b);
  if (lb) return { why: 'Waiting: ' + lb, cost };
  if (!canAfford(cost)) {
    const need = RES.filter((r) => S.res[r] < cost[r]).map((r) => `${fmt(cost[r] - S.res[r])} more ${r}`).join(', ');
    return { why: `A builder is free, but you can't pay yet. Needs ${need}. It starts by itself as soon as you have it.`, cost, poor: true };
  }
  return { why: '', cost };
}
// When will resources cover the lined-up upgrade? (used so it also starts on time while you are away)
function nextAffordAt(t, prodUntil) {
  const st = nextUpStatus(t); if (!st || !st.poor || t >= prodUntil) return Infinity;
  let worst = t;
  for (const r of RES) {
    const short = st.cost[r] - S.res[r]; if (short <= 0) continue;
    const rate = prodPerHour(r, t); if (rate <= 0) return Infinity;
    worst = Math.max(worst, t + Math.ceil(short / rate * HOUR) + 1);
  }
  return worst > t && worst <= prodUntil ? worst : Infinity;
}
function tryStartNext(t) {
  const st = nextUpStatus(t); if (!st) return false;
  const n = S.nextUp;
  if (st.drop) { S.nextUp = null; logEvent(`Lined-up upgrade removed: ${st.why}`); return false; }
  if (st.why) return false;
  pay(st.cost);
  const L = S.b[n.key], time = upTime(n.key, L, t);
  S.queue.push({ key: n.key, to: L + 1, start: t, end: t + time });
  S.nextUp = null;
  addXP(10);
  logEvent(`Lined-up upgrade started: ${bName(n.key)} to level ${L + 1} (paid ${costText(st.cost)}). Ready in ${fmtDur(time)}.`, 'good');
  changed();
  return true;
}
function finishUpgrade(q, t) {
  S.b[q.key] = q.to;
  if (q.key === 'spire') {
    S.perkChoices.push(q.to);
    if (!extendShield(SHIELD_LEVELUP, t, true)) logEvent(`No level-up shield this time: max 1 shield per ${fmtDur(T(SHIELD_CAP_WINDOW))}. Next shield allowed in ${fmtDur(shieldReadyAt() - t)}.`);
    postFeed(`🏰 ${S.name} raised their Spire to level ${q.to}!`, 'levelup');
  }
  logEvent(`${q.key === 'spire' ? 'Spire' : BUILDINGS[q.key].name} reached level ${q.to}.`);
}
function perkOptions(level) {
  const pool = PKEYS.slice();
  let h = hash(S.seed + ':' + level);
  const out = [];
  while (out.length < 3) { const i = h % pool.length; out.push(pool.splice(i, 1)[0]); h = hash(String(h)); }
  return out;
}
function choosePerk(level, k) {
  if (!S.perkChoices.includes(level)) return;
  S.perks.push(k);
  S.perkChoices = S.perkChoices.filter((l) => l !== level);
  toast(`Perk chosen: ${PERKS[k].name}.`, 'good');
  save(); changed(); render();
}

// ======================= Troops =======================
function troopPower(type, tier) {
  return T_POWER[tier] * (1 + 0.1 * hasPerk('army') + 0.2 * hasPerk(type) + fBonus(type));
}
function armyPower(vsLike) { // vsLike: monster kind's troop-like type, or null
  let p = 0;
  for (const type of TKEYS) {
    let m = 1;
    if (vsLike) { if (TROOPS[type].beats === vsLike) m = 1.5; else if (TROOPS[vsLike].beats === type) m = 0.7; }
    S.army[type].forEach((n, tier) => { p += n * troopPower(type, tier) * m; });
  }
  return Math.round(p);
}
const troopCount = () => TKEYS.reduce((s, t) => s + S.army[t].reduce((a, b) => a + b, 0), 0);
function defensePower() {
  return Math.round(wallDefense(S.b.spire) * (1 + 0.25 * hasPerk('wall') + fBonus('wall')) + armyPower(null));
}
// Wounded vs killed. Defenders: 70% of losses wounded. Attackers: 30%. Losing a siege: 10%.
// Wounded go to the Infirmary; if it is full, the overflow dies. Winners heal 10% of wounded on the spot.
const WOUND_SHARE = { defender: 0.7, attacker: 0.3, siegeLost: 0.1 };
const infCap = () => Math.round(40 * Math.pow(1.7, S.b.infirmary - 1));
const woundedCount = () => TKEYS.reduce((s, t) => s + S.wounded[t].reduce((a, b) => a + b, 0), 0);
const healPerHour = () => infCap() * (S.fast ? 60 : 1);
function applyLosses(fracByType, role, won) {
  const rep = { lost: 0, wounded: 0, killed: 0, healed: 0 };
  let room = Math.max(0, infCap() - woundedCount());
  for (const type of TKEYS) {
    const f = typeof fracByType === 'number' ? fracByType : (fracByType[type] || 0);
    S.army[type] = S.army[type].map((n, tier) => {
      const lost = Math.min(n, Math.round(n * f));
      let w = Math.round(lost * WOUND_SHARE[role]);
      const healNow = won ? Math.round(w * 0.1) : 0;
      w -= healNow;
      const wIn = Math.min(w, room); room -= wIn;
      S.wounded[type][tier] += wIn;
      rep.lost += lost; rep.healed += healNow; rep.wounded += wIn; rep.killed += lost - healNow - wIn;
      return n - lost + healNow;
    });
  }
  return rep;
}
const lossText = (r) => `Wounded ${fmt(r.wounded)} (to Infirmary), killed ${fmt(r.killed)}, healed on the spot ${fmt(r.healed)}.`;
function loseTroops(frac, role = 'defender', won = false) { return applyLosses(frac, role, won); }
function healStep(hours) {
  S.healAcc += healPerHour() * hours;
  let n = Math.floor(S.healAcc);
  if (n <= 0) return;
  S.healAcc -= n;
  for (const type of TKEYS) for (let tier = 0; tier < 3 && n > 0; tier++) {
    const k = Math.min(n, S.wounded[type][tier]);
    S.wounded[type][tier] -= k; S.army[type][tier] += k; n -= k; S.healedTotal += k;
  }
  if (woundedCount() === 0) S.healAcc = 0;
}
function healNow() {
  const n = woundedCount(); if (!n) return;
  let cost = each(0);
  for (const type of TKEYS) S.wounded[type].forEach((w, tier) => { const c = trainCost(tier, w); RES.forEach((r) => { cost[r] += Math.round(c[r] / 2); }); });
  if (!canAfford(cost)) return toast(`Healing everyone now costs ${fmt(cost.grain)} grain, ${fmt(cost.timber)} timber, ${fmt(cost.ore)} ore (half the training cost). Not enough yet.`, 'bad');
  pay(cost);
  for (const type of TKEYS) S.wounded[type].forEach((w, tier) => { S.army[type][tier] += w; S.wounded[type][tier] = 0; });
  S.healedTotal += n;
  toast(`Healed ${fmt(n)} troops for resources.`, 'good');
  save(); changed(); render();
}
function trainCost(tier, n) {
  const c = T_COST[tier], m = 1 - 0.15 * Math.min(3, hasPerk('cheap'));
  return { grain: Math.round(c.grain * n * m), timber: Math.round(c.timber * n * m), ore: Math.round(c.ore * n * m) };
}
function trainTime(tier, n) { return T(Math.min(4 * HOUR, T_SEC[tier] * n / boostMult())); }
function startTrain(type, tier, n) {
  if (S.train) return toast('The Barracks is already training. Wait for it to finish.', 'bad');
  if (S.b.barracks < TIER_UNLOCK[tier]) return toast(`Tier ${tier + 1} needs Barracks level ${TIER_UNLOCK[tier]}.`, 'bad');
  const cost = trainCost(tier, n);
  if (!canAfford(cost)) return toast('Not enough resources for that many troops.', 'bad');
  pay(cost);
  const now = Date.now(), time = trainTime(tier, n);
  S.train = { type, tier, n, start: now, end: now + time };
  toast(`Training ${n} tier ${tier + 1} ${TROOPS[type].name}. Ready in ${fmtDur(time)}.`);
  save(); changed(); render();
}

// ======================= Shields, raids, revenge =======================
// Max 1 new shield per 8 hours (T-scaled), from any source. exempt = the automatic shield after losing
// a raid: it is never blocked, but it still counts as your shield for the next 8 hours.
const shieldReadyAt = () => (S.lastShieldAt || 0) + T(SHIELD_CAP_WINDOW);
const shieldAllowed = (t = Date.now()) => t >= shieldReadyAt();
function extendShield(ms, t = Date.now(), earned = true, exempt = false) {
  if (!exempt && !shieldAllowed(t)) return 0; // capped: caller explains why
  const dur = T(ms * (earned ? (1 + 0.25 * hasPerk('shield')) : 1));
  S.shieldUntil = Math.max(S.shieldUntil, t) + dur;
  S.lastShieldAt = t;
  return dur;
}
const shieldCapText = (t = Date.now()) => `Max 1 shield per ${fmtDur(T(SHIELD_CAP_WINDOW))}. You got one ${fmtDur(t - S.lastShieldAt)} ago. Next shield allowed in ${until(shieldReadyAt())}.`;
const shieldUp = (t = Date.now()) => S.shieldUntil > t;
const nextRival = () => (S.raid.grudge && RIVALS.find((r) => r.id === S.raid.grudge)) || RIVALS[S.raid.idx % RIVALS.length];
// Honest, fixed rule. No dice: the numbers you see decide it.
function raidOutcome(atk, def) {
  if (def >= atk) return 'held';
  if (atk >= 2 * def) return 'wipe';
  return 'lost';
}
function resolveRaid(t) {
  S.raid.next = t + T(RAID_EVERY);
  if (shieldUp(t)) { logEvent('A rival scouted your Spire, but your shield was up.'); return; }
  const rival = nextRival();
  if (S.raid.grudge) S.raid.grudge = null; else S.raid.idx++;
  const L = S.b.spire, atk = rivalAttack(rival, L, t), def = defensePower();
  const out = raidOutcome(atk, def);
  const entry = { id: Date.now() + Math.random(), rival: rival.id, t, atk, def, out, took: each(0), done: false };
  if (out === 'held') {
    entry.loss = loseTroops(0.1, 'defender', true); entry.rivalLoss = rivalLosses(rival, atk, 0.3, 'attacker', t);
    const bonus = Math.round(atk * 0.5);
    gain(each(bonus)); entry.gained = bonus;
    S.stats.raidsHeld++;
    logEvent(`${rival.name} attacked (${fmt(atk)}) but your defense (${fmt(def)}) held! ${lossText(entry.loss)} You took ${fmt(bonus)} of each resource from them.`, 'good');
    postFeed(`🛡️ ${S.name} HELD the Spire against ${rival.name}. Attack ${fmt(atk)} vs defense ${fmt(def)}.`, 'held');
  } else if (out === 'lost') {
    RES.forEach((r) => { entry.took[r] = Math.floor(S.res[r] * 0.5); S.res[r] -= entry.took[r]; });
    entry.loss = loseTroops(0.3, 'defender'); entry.rivalLoss = rivalLosses(rival, atk, 0.1, 'attacker', t, true);
    S.repairUntil = Math.max(S.repairUntil, t + T(REPAIR_TIME / 3));
    S.stats.raidsLost++;
    const lsh = extendShield(SHIELD_AFTER_LOSS, t, false, true);
    logEvent(`${rival.name} RAIDED you. Attack ${fmt(atk)} beat your defense ${fmt(def)}. They took half your resources and damaged your buildings (no output for ${fmtDur(T(REPAIR_TIME / 3))}). ${lossText(entry.loss)} You get an automatic ${fmtDur(lsh)} shield.`, 'bad');
    postFeed(`⚔️ ${rival.name} raided ${S.name}! Took ${fmt(entry.took.grain)} grain, ${fmt(entry.took.timber)} timber, ${fmt(entry.took.ore)} ore.`, 'raid');
  } else {
    RES.forEach((r) => { entry.took[r] = Math.floor(S.res[r]); S.res[r] = 0; });
    entry.loss = loseTroops(1, 'defender'); entry.rivalLoss = rivalLosses(rival, atk, 0.05, 'attacker', t, true);
    S.repairUntil = t + T(REPAIR_TIME);
    S.stats.wipes++;
    // Getting back up: comeback boost, starter resources, short recovery shield.
    S.boost = { until: t + T(COMEBACK_TIME), mult: COMEBACK_MULT, why: 'Comeback Tailwind' };
    const starter = giftAmt(S.b.spire);
    gain(each(starter));
    S.army.inf[0] += 10; S.army.cav[0] += 10; S.army.rng[0] += 10;
    const wsh = extendShield(SHIELD_AFTER_LOSS, t, false, true);
    logEvent(`WIPED by ${rival.name}! Attack ${fmt(atk)} was double your defense ${fmt(def)}. All stored resources are gone, every troop at home fell (${lossText(entry.loss)}) and your buildings make nothing for ${fmtDur(T(REPAIR_TIME))} while they are repaired. Comeback Tailwind is on (${COMEBACK_MULT}x for ${fmtDur(T(COMEBACK_TIME))}), you got ${fmt(starter)} of each resource and 30 fresh troops, and an automatic ${fmtDur(wsh)} shield.`, 'bad');
    postFeed(`💥 ${rival.name} WIPED ${S.name}'s Spire to zero!`, 'wipe');
  }
  S.revenge.unshift(entry);
  S.revenge = S.revenge.slice(0, 20);
}
// ======================= Sea monsters =======================
// ======================= Time engine (offline progress) =======================
let eventLog = []; // events since the player last looked
function logEvent(text, kind) { eventLog.push({ text, kind: kind || '' }); }
function advance(to) {
  let t = S.last;
  if (to <= t) return;
  const prodUntil = Math.min(to, t + OFFLINE_CAP);
  let guard = 0;
  while (t < to && guard++ < 10000) {
    const evs = [to];
    S.queue.forEach((q) => evs.push(q.end));
    if (S.train) evs.push(S.train.end);
    evs.push(S.raid.next, S.shieldUntil, S.repairUntil, prodUntil);
    if (S.boost) evs.push(S.boost.until);
    if (S.nextUp) evs.push(nextAffordAt(t, prodUntil)); // lined-up upgrade starts the moment it can be paid
    const next = Math.min(...evs.filter((x) => x > t));
    const prodEnd = Math.min(next, prodUntil);
    if (prodEnd > t) {
      const h = (prodEnd - t) / HOUR;
      RES.forEach((r) => { S.res[r] += prodPerHour(r, t) * h; });
    }
    healStep((next - t) / HOUR);
    t = next;
    S.queue.filter((q) => q.end <= t).forEach((q) => finishUpgrade(q, t));
    S.queue = S.queue.filter((q) => q.end > t);
    if (S.nextUp) tryStartNext(t);
    if (S.train && S.train.end <= t) {
      S.army[S.train.type][S.train.tier] += S.train.n;
      logEvent(`${S.train.n} tier ${S.train.tier + 1} ${TROOPS[S.train.type].name} finished training.`);
      S.train = null;
    }
    if (S.raid.next <= t) resolveRaid(t);
  }
  S.last = to;
}

// ======================= Daily, ads, season pass =======================
function claimGift() {
  if (S.daily.gift === today()) return;
  S.daily.gift = today(); S.daily.gifts++;
  const amt = giftAmt(S.b.spire);
  gain(each(amt)); S.gems += 10; S.tele.tokens += 1;
  const d = extendShield(SHIELD_DAILY);
  addXP(20);
  const shTxt = d ? `and a ${fmtDur(d)} shield` : `but no shield this time (max 1 shield per ${fmtDur(T(SHIELD_CAP_WINDOW))}; next one allowed in ${fmtDur(shieldReadyAt() - Date.now())})`;
  toast(`Daily gift: +${fmt(amt)} of each resource, +10 Gems, +1 Teleport, ${shTxt}. (Gifts never reset. Total collected: ${S.daily.gifts}.)`, 'good');
  save(); changed(); render();
}
function watchAd() {
  if (S.daily.adsDay !== today()) { S.daily.adsDay = today(); S.daily.ads = 0; }
  if (S.daily.ads >= 5) return toast('That is the 5 demo ads for today.', 'bad');
  S.daily.ads++; S.gems += 1;
  toast(`Demo ad (nothing was shown). +1 Gem. ${5 - S.daily.ads} left today.`, 'good');
  save(); changed(); render();
}
const PASS_TIERS = [
  { free: { res: 300 },  prem: { theme: 'sunset' } },
  { free: { gems: 5 },   prem: { skip: 15 } },
  { free: { res: 800 },  prem: { gems: 10 } },
  { free: { shards: 10 }, prem: { theme: 'night' } },
  { free: { res: 2000 }, prem: { skip: 30 } },
  { free: { gems: 10 },  prem: { theme: 'seaglass' } },
  { free: { res: 5000 }, prem: { skip: 60 } },
  { free: { shards: 25 }, prem: { gems: 20 } },
  { free: { res: 12000 }, prem: { skip: 60 } },
  { free: { gems: 20 },  prem: { shards: 50 } },
];
const PASS_XP = 100;
function addXP(n) { S.pass.xp += n; }
function rewardText(r) {
  if (r.res) return `${fmt(r.res)} of each resource`;
  if (r.gems) return `${r.gems} Gems`;
  if (r.shards) return `${r.shards} Shards`;
  if (r.theme) return `"${THEMES[r.theme].name}" Isle look`;
  if (r.skip) return `${r.skip}-minute time skip`;
  return '';
}
function grant(r) {
  if (r.res) gain(each(r.res));
  if (r.gems) S.gems += r.gems;
  if (r.shards) S.shards += r.shards;
  if (r.theme && !S.cos.owned.includes(r.theme)) S.cos.owned.push(r.theme);
  if (r.skip) skipTime(r.skip * MIN, true);
}
function claimPass(i, track) {
  const id = track + i;
  if (S.pass.claimed.includes(id) || S.pass.xp < (i + 1) * PASS_XP) return;
  if (track === 'p' && !S.pass.premium) return;
  S.pass.claimed.push(id);
  grant(PASS_TIERS[i][track === 'f' ? 'free' : 'prem']);
  toast(`Claimed: ${rewardText(PASS_TIERS[i][track === 'f' ? 'free' : 'prem'])}.`, 'good');
  save(); changed(); render();
}

// ======================= Shop (demo: no real payments) =======================
const THEMES = {
  sunset:   { name: 'Sunset', shards: 30, gems: 15 },
  night:    { name: 'Night Sky', shards: 40, gems: 20 },
  seaglass: { name: 'Sea Glass', shards: 50, gems: 25 },
};
function skipTime(ms, free) {
  // Moves your build and training timers forward. Does not move raids or shields.
  const target = S.queue[0] || null;
  S.queue.forEach((q) => { q.end -= ms; });
  if (S.train) S.train.end -= ms;
  if (!target && !S.train && !free) return false;
  return true;
}
function buySkip(mins, gems) {
  if (!S.queue.length && !S.train) return toast('Nothing is building or training right now.', 'bad');
  if (S.gems < gems) return toast('Not enough Gems. Earn them from daily gifts, monsters, and the season pass.', 'bad');
  S.gems -= gems; skipTime(mins * MIN);
  toast(`Skipped ${mins} minutes on all builds and training. (-${gems} Gems)`, 'good');
  save(); changed(); render();
}
// 1 Gem per 3 minutes for the first hour left, then 1 Gem per 2 minutes beyond an hour.
function finishNowCost(q, t = Date.now()) {
  const left = Math.max(0, q.end - t), first = Math.min(left, HOUR), rest = left - first;
  return Math.max(1, Math.ceil(first / (FINISH_MIN_PER_GEM * MIN)) + Math.ceil(rest / (FINISH_MIN_PER_GEM_LONG * MIN)));
}
function finishNow(i) {
  const q = S.queue[i]; if (!q) return;
  const c = finishNowCost(q);
  if (S.gems < c) return toast(`Finishing now costs ${c} Gems. You have ${S.gems}.`, 'bad');
  S.gems -= c; q.end = Date.now();
  toast(`Finished now for ${c} Gems.`, 'good');
  save(); changed(); render();
}
function buyShield(hours, gems) {
  if (!shieldAllowed()) return toast(`Shield limit: max 1 shield per ${fmtDur(T(SHIELD_CAP_WINDOW))}. Next shield allowed in ${fmtDur(shieldReadyAt() - Date.now())}.`, 'bad');
  if (S.gems < gems) return toast('Not enough Gems.', 'bad');
  S.gems -= gems;
  const d = extendShield(hours * HOUR, Date.now(), false);
  toast(`Shield added: ${fmtDur(d)}. (-${gems} Gems)`, 'good');
  save(); changed(); render();
}
function buyTheme(k, cur) {
  const th = THEMES[k];
  if (S.cos.owned.includes(k)) { S.cos.theme = S.cos.theme === k ? '' : k; applyTheme(); save(); changed(); render(); return; }
  if (cur === 'shards') { if (S.shards < th.shards) return toast('Not enough Shards.', 'bad'); S.shards -= th.shards; }
  else { if (S.gems < th.gems) return toast('Not enough Gems.', 'bad'); S.gems -= th.gems; }
  S.cos.owned.push(k); S.cos.theme = k; applyTheme();
  toast(`New Isle look: ${th.name}.`, 'good');
  save(); changed(); render();
}
function applyTheme() { document.body.className = S.cos.theme ? 'theme-' + S.cos.theme : ''; }

// ======================= Fights: monsters, counter-raids, hunts =======================
// Every fight can be played on the grid or auto-resolved. Auto-resolve uses the shown rule:
// your power vs their power, bigger number wins (monsters: counters count; rivals: plain power).
const HUNT_COOLDOWN = 2 * HOUR, ALERT_TIME = 5 * MIN, RIVAL_CYCLE = 4 * HOUR, HIT_SHIELD = 1 * HOUR;
function rivalShield(r, t = Date.now()) { // returns {up, until}
  const st = S.rivals[r.id] || {};
  if (st.hitShieldUntil && st.hitShieldUntil > t) return { up: true, until: st.hitShieldUntil, why: 'shield after being hit' };
  const P = T(RIVAL_CYCLE), off = hash(r.id) % P, ph = (t + off) % P;
  if (ph < 0.75 * P) return { up: true, until: t + (0.75 * P - ph), why: 'regular shield' };
  return { up: false, until: t + (P - ph) };
}
const SURPRISE = 1.3, SURPRISE_TIME = 5 * MIN;
function fightCtx(kind, opts) {
  if (kind === 'monster') {
    const m = monster(opts.lvl);
    return { kind, lvl: opts.lvl, title: `Level ${m.lvl} ${m.kind.name}`, enemyPower: m.power, enemyLike: m.kind.like,
      myPower: armyPower(m.kind.like), rule: 'You win if your power (with counters) is at least the monster\'s power.' };
  }
  const r = RIVALS.find((x) => x.id === opts.rival);
  const def = rivalDefense(r, S.b.spire);
  const surprise = kind === 'hunt' && S.tele.near === r.id && S.tele.surpriseUntil > Date.now();
  return { kind, rival: r.id, revengeId: opts.revengeId, title: `${r.name}'s Spire`, surprise,
    enemyPower: surprise ? Math.round(def / SURPRISE) : def, fullDefense: def, enemyLike: null, myPower: armyPower(null),
    rule: 'You win if your army power is bigger than their defense. Double their defense or more = you WIPE them.' +
      (surprise ? ` SURPRISE SIEGE: you caught them with no shield. Walls unmanned and troops out of formation, so their defense counts ${Math.round((1 - 1 / SURPRISE) * 100)}% less (${fmt(def)} → ${fmt(Math.round(def / SURPRISE))}).` : '') };
}
function canStartFight(ctx) {
  if (troopCount() === 0) return 'You have no troops. Train some at the Barracks.';
  if (ctx.kind === 'monster' && (S.monsters[ctx.lvl] || 0) > Date.now()) return 'That monster is not back yet.';
  if (ctx.kind === 'hunt') {
    const r = RIVALS.find((x) => x.id === ctx.rival);
    if (S.tele.near !== r.id) return 'Teleport next to them first.';
    if (S.tele.alertUntil > Date.now()) return `They are on alert for ${fmtDur(S.tele.alertUntil - Date.now())}. Wait.`;
    if (rivalShield(r).up) return `Their shield is up for ${fmtDur(rivalShield(r).until - Date.now())}.`;
  }
  if (ctx.kind === 'counter') {
    const e = S.revenge.find((x) => x.id === ctx.revengeId);
    if (!e || e.done) return 'You already used this revenge.';
  }
  return '';
}
function autoResolve(ctx) {
  const won = ctx.kind === 'monster' ? ctx.myPower >= ctx.enemyPower : ctx.myPower > ctx.enemyPower;
  const lostFrac = won ? Math.min(0.5, 0.3 * ctx.enemyPower / Math.max(1, ctx.myPower)) : (ctx.kind === 'monster' ? 0.4 : 0.3);
  finishFight(ctx, won, lostFrac, null, 'auto-resolve');
}
function finishFight(ctx, won, lostFrac, perTypeLoss, how) {
  const isSiege = ctx.kind !== 'monster';
  const role = won ? 'attacker' : (isSiege ? 'siegeLost' : 'attacker');
  const loss = applyLosses(perTypeLoss || lostFrac, role, won);
  let msg = '';
  if (ctx.kind === 'monster') {
    const m = monster(ctx.lvl);
    S.monsters[ctx.lvl] = Date.now() + T(MONSTER_RESPAWN);
    if (won) {
      const loot = Math.round(m.loot * (1 + 0.25 * hasPerk('loot') + fBonus('loot')));
      gain(each(loot)); S.gems += m.gems; S.shards += m.shards; addXP(15);
      const find = rollDrop();
      msg = `You beat the ${ctx.title} (${how})! +${fmt(loot)} of each resource, +${m.shards} Shards${m.gems ? `, +${m.gems} Gems` : ''}. Find: ${find.tier.name} ${find.item}${find.pity ? ' (pity drop)' : ''}. Your troops: ${lossText(loss)}`;
    } else msg = `The ${ctx.title} was too strong (${how}). No loot. Your troops: ${lossText(loss)}`;
  } else {
    const r = RIVALS.find((x) => x.id === ctx.rival);
    if (shieldUp()) S.shieldUntil = Date.now(); // attacking drops your own shield (shown on screen)
    const st = S.rivals[r.id] = S.rivals[r.id] || {};
    S.raid.grudge = r.id; // whoever you hit raids you next (shown on screen)
    if (ctx.kind === 'counter') { const e = S.revenge.find((x) => x.id === ctx.revengeId); if (e) e.done = true; }
    const theirs = rivalLosses(r, ctx.fullDefense, won ? 0.4 : 0.1, 'defender', Date.now(), !won);
    const theirText = `${r.name}'s troops: wounded ${fmt(theirs.wounded)}, killed ${fmt(theirs.killed)}, healed ${fmt(theirs.healed)}.`;
    if (won) {
      const wipe = ctx.myPower >= 2 * ctx.enemyPower;
      const e = ctx.revengeId && S.revenge.find((x) => x.id === ctx.revengeId);
      const back = {}; RES.forEach((k) => { back[k] = Math.round(((e ? e.took[k] * 1.2 : 0) + ctx.fullDefense * 0.8) * (wipe ? 2 : 1)); });
      gain(back); S.gems += wipe ? 10 : 3; addXP(25); S.stats.revengeWins++;
      st.hitShieldUntil = Date.now() + T(HIT_SHIELD);
      st.weakUntil = Date.now() + T(wipe ? 2 * HOUR : HOUR); st.weakMult = wipe ? 0.5 : 0.8; // damaged buildings
      if (ctx.kind === 'hunt') { S.tele.near = null; S.tele.surpriseUntil = 0; }
      msg = `${wipe ? 'WIPE! ' : ''}You beat ${r.name} (${how})! Took ${fmt(back.grain)} of each resource and ${wipe ? 10 : 3} Gems. Their buildings are damaged: they are ${wipe ? '50' : '20'}% weaker for ${fmtDur(T(wipe ? 2 * HOUR : HOUR))}. Your troops: ${lossText(loss)} ${theirText} ${r.name} will raid you next.`;
      postFeed(`${wipe ? '💥' : '🔥'} ${ctx.revengeId ? 'REVENGE! ' : ''}${S.name} ${wipe ? 'WIPED' : 'sieged'} ${r.name}'s Spire${ctx.surprise ? ' in a surprise attack' : ''} and took ${fmt(back.grain)} of each resource.`, 'revenge');
    } else {
      msg = `${r.name}'s defense held (${how}). Losing a siege is costly. Your troops: ${lossText(loss)} ${theirText} ${r.name} will raid you next.`;
      postFeed(`😬 ${S.name}'s siege on ${r.name} broke.`, 'revengefail');
    }
  }
  battle = null;
  if (activeTab === 'battle') activeTab = 'army';
  lastReport = { msg, won, t: Date.now() };
  toast(msg, won ? 'good' : 'bad');
  save(); changed(); render();
}
let lastReport = null;
function teleport(rivalId, revengeId) {
  const r = RIVALS.find((x) => x.id === rivalId);
  const now = Date.now();
  if (revengeId) {
    const e = S.revenge.find((x) => x.id === revengeId);
    if (!e || e.teleUsed) return;
    e.teleUsed = true; // revenge teleports are free and skip the cooldown
  } else {
    if (S.tele.cooldownUntil > now) return toast(`Teleport is cooling down for ${fmtDur(S.tele.cooldownUntil - now)}.`, 'bad');
    if (S.tele.tokens < 1) return toast('No Teleports left. You get 1 with each daily gift.', 'bad');
    S.tele.tokens--; S.tele.cooldownUntil = now + T(HUNT_COOLDOWN);
  }
  S.tele.near = r.id;
  if (!rivalShield(r).up) {
    S.tele.alertUntil = 0; S.tele.surpriseUntil = now + Math.max(30e3, T(SURPRISE_TIME));
    toast(`Your Spire landed next to ${r.name} and their shield is DOWN. Surprise siege ready for ${fmtDur(Math.max(30e3, T(SURPRISE_TIME)))}: their defense counts 23% less. Attack now!`, 'good');
  } else {
    S.tele.alertUntil = now + Math.max(30e3, T(ALERT_TIME)); S.tele.surpriseUntil = 0;
    toast(`Your Spire landed next to ${r.name}. They got a warning and are on alert for ${fmtDur(Math.max(30e3, T(ALERT_TIME)))}. Attack when the alert ends and their shield is down.`, 'good');
  }
  postChat('kingdom', r.name, pick([`Who just parked a Spire next to mine? ${S.name}? Bold.`, `I see you, ${S.name}. Come and try.`, `A hostile Spire landed next door. Shields ready, crew!`]));
  save(); changed(); render();
}

// ======================= Grid battle (8 x 6, turn-based) =======================
const COLS = 8, ROWS = 6;
const RANGE = { inf: 1, cav: 1, rng: 3 }, MOVE = { inf: 1, cav: 2, rng: 1 };
const ICON = { inf: '🛡', cav: '🐎', rng: '🏹' };
let battle = null; // {ctx, units, hills, turn, sel, acted:{}, log:[], over}
function makeHills(seed) { const h = new Set(); let x = hash('hills' + seed); while (h.size < 5) { const c = 2 + (x % 4), r = (x >> 4) % ROWS; h.add(c + ',' + r); x = hash(String(x)); } return h; }
function startGrid(ctx) {
  const why = canStartFight(ctx); if (why) return toast(why, 'bad');
  const units = [];
  const rows = [1, 2, 4];
  TKEYS.forEach((type, i) => {
    const hp = S.army[type].reduce((s, n, tier) => s + n * troopPower(type, tier), 0);
    if (hp > 0) units.push({ id: 'p' + type, side: 'me', type, hp, max: hp, c: 0, r: rows[i] });
  });
  const eTypes = ctx.enemyLike ? [ctx.enemyLike, ctx.enemyLike, ctx.enemyLike] : TKEYS;
  eTypes.forEach((type, i) => units.push({ id: 'e' + i, side: 'ai', type, hp: ctx.enemyPower / 3, max: ctx.enemyPower / 3, c: COLS - 1, r: rows[i] }));
  battle = { ctx, units, hills: makeHills(Date.now()), turn: 1, sel: null, acted: {}, moved: {}, log: ['Battle started. Your units are blue, on the left.'], over: false };
  activeTab = 'battle'; $('toast').hidden = true; changed(); render(); window.scrollTo(0, 0);
}
const unitAt = (c, r) => battle.units.find((u) => u.hp > 0 && u.c === c && u.r === r);
const dist = (a, b) => Math.abs(a.c - b.c) + Math.abs(a.r - b.r);
function counterMult(att, def) { if (TROOPS[att].beats === def) return 1.5; if (TROOPS[def].beats === att) return 0.7; return 1; }
function damage(a, d) {
  let m = counterMult(a.type, d.type);
  if (battle.hills.has(a.c + ',' + a.r)) m *= 1.25;
  const flank = battle.units.some((u) => u.hp > 0 && u.side === a.side && u !== a && dist(u, d) === 1);
  if (flank) m *= 1.25;
  return { dmg: Math.max(1, a.max * 0.35 * m * (0.5 + 0.5 * a.hp / a.max)), m, flank };
}
function strike(a, d) {
  const { dmg, m, flank } = damage(a, d);
  d.hp = Math.max(0, d.hp - dmg);
  const who = a.side === 'me' ? 'Your' : 'Enemy';
  battle.log.unshift(`${who} ${TROOPS[a.type].name} hit ${a.side === 'me' ? 'enemy' : 'your'} ${TROOPS[d.type].name} for ${fmt(dmg)}${m > 1.3 && m < 1.6 ? ' (counter bonus!)' : ''}${flank ? ' (flank bonus)' : ''}${d.hp <= 0 ? '. It is defeated!' : '.'}`);
}
function gridClick(c, r) {
  if (!battle || battle.over) return;
  const u = unitAt(c, r);
  const sel = battle.sel && battle.units.find((x) => x.id === battle.sel);
  if (u && u.side === 'me') { battle.sel = battle.acted[u.id] ? null : u.id; return render(); }
  if (!sel) return;
  if (u && u.side === 'ai') {
    if (dist(sel, u) <= RANGE[sel.type]) { strike(sel, u); battle.acted[sel.id] = true; battle.sel = null; checkEnd(); }
    else battle.log.unshift('Too far to attack. Move closer first.');
    return render();
  }
  if (!u && !battle.moved[sel.id] && dist(sel, { c, r }) <= MOVE[sel.type]) {
    sel.c = c; sel.r = r; battle.moved[sel.id] = true;
  }
  render();
}
function endTurn() {
  if (!battle || battle.over) return;
  for (const e of battle.units.filter((x) => x.side === 'ai' && x.hp > 0)) {
    const foes = battle.units.filter((x) => x.side === 'me' && x.hp > 0);
    if (!foes.length) break;
    // AI: attack the target it hurts most in range, otherwise step toward the nearest foe.
    let inRange = foes.filter((f) => dist(e, f) <= RANGE[e.type]);
    if (!inRange.length) {
      const near = foes.reduce((a, b) => dist(e, a) <= dist(e, b) ? a : b);
      for (let s = 0; s < MOVE[e.type]; s++) {
        const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => ({ c: e.c + dc, r: e.r + dr }))
          .filter((p) => p.c >= 0 && p.c < COLS && p.r >= 0 && p.r < ROWS && !unitAt(p.c, p.r))
          .sort((a, b) => dist(a, near) - dist(b, near));
        if (opts.length && dist(opts[0], near) < dist(e, near)) { e.c = opts[0].c; e.r = opts[0].r; }
        if (dist(e, near) <= RANGE[e.type]) break;
      }
      inRange = foes.filter((f) => dist(e, f) <= RANGE[e.type]);
    }
    if (inRange.length) strike(e, inRange.reduce((a, b) => counterMult(e.type, a.type) >= counterMult(e.type, b.type) ? a : b));
  }
  battle.turn++; battle.acted = {}; battle.moved = {}; battle.sel = null;
  checkEnd(); render();
}
function checkEnd() {
  const mine = battle.units.filter((u) => u.side === 'me' && u.hp > 0).length;
  const theirs = battle.units.filter((u) => u.side === 'ai' && u.hp > 0).length;
  if (mine && theirs && battle.turn <= 12) return;
  const won = theirs === 0;
  const loss = {};
  battle.units.filter((u) => u.side === 'me').forEach((u) => { loss[u.type] = won ? (1 - u.hp / u.max) * 0.6 : Math.max(0.4, 1 - u.hp / u.max); });
  battle.over = true;
  if (!won && mine && theirs) battle.log.unshift('12 turns passed. The enemy holds the field.');
  finishFight(battle.ctx, won, 0, loss, 'grid battle');
}
function retreat() { if (!battle) return; const ctx = battle.ctx; battle.over = true; const loss = {}; TKEYS.forEach((t) => { loss[t] = 0.15; }); finishFight(ctx, false, 0, loss, 'retreated'); }

// ======================= Forecast: BTC up or down (pays in-game resources only) =======================
const FEE_PER_SIDE = 2, MIN_P = 0.03, MAX_P = 0.97, ANNUAL_VOL = 0.5, SEC_PER_YEAR = 365 * 24 * 3600;
const feed = { live: null, liveAt: 0, source: '', fails: 0, sim: null };
async function fetchJSON(url, ms = 5000) {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}
async function fetchLive() {
  if (FORCE_SIM) throw new Error('simulation forced');
  try { const j = await fetchJSON('https://api.coinbase.com/v2/prices/BTC-USD/spot'); const p = parseFloat(j.data.amount); if (p > 0) return { price: p, source: 'Coinbase' }; } catch (e) { /* backup */ }
  const j = await fetchJSON('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
  const p = parseFloat(Object.values(j.result)[0].c[0]); if (p > 0) return { price: p, source: 'Kraken' };
  throw new Error('no price');
}
let polling = false;
async function poll() {
  if (polling) return; polling = true; const askedAt = Date.now();
  try { const r = await fetchLive(); feed.live = r.price; feed.liveAt = askedAt; feed.source = r.source; feed.fails = 0; feed.sim = r.price; }
  catch (e) { feed.fails++; } finally { polling = false; }
}
async function candleOpen(tMs) {
  const s = new Date(tMs).toISOString(), e = new Date(tMs + 60000).toISOString();
  const rows = await fetchJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${s}&end=${e}`);
  const row = Array.isArray(rows) && rows.find((r) => r[0] * 1000 === tMs);
  if (!row) throw new Error('no candle yet'); return row[3];
}
const liveOk = () => !FORCE_SIM && feed.live != null && Date.now() - feed.liveAt < 15000;
const usingSim = () => FORCE_SIM || (!liveOk() && feed.fails >= 2);
function stepSim() { if (liveOk()) return; if (feed.sim == null) feed.sim = 80000; feed.sim = Math.round(feed.sim * Math.exp(ANNUAL_VOL / Math.sqrt(SEC_PER_YEAR) * gaussian()) * 100) / 100; }
function gaussian() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return z > 0 ? 1 - p : p; }
const fcLen = () => S.fast ? MIN : 15 * MIN;
const fcLock = () => S.fast ? 5000 : 10000;
function fcDayReset() { if (S.fc.day !== today()) { S.fc.day = today(); S.fc.used = 0; S.fc.earned = each(0); } }
const fcCallsPerDay = () => 3 + S.b.tower + 2 * hasPerk('calls');
const fcBase = () => Math.round(1200 * S.b.spire * Math.pow(1.2, S.b.spire) / 6); // about 10 minutes of normal-speed farm output
const fcCap = () => 6 * fcBase();
function fcRound() {
  const L = fcLen(), start = Math.floor(Date.now() / L) * L, id = (S.fast ? 'q' : 'n') + start;
  if (!S.fc.rounds[id]) S.fc.rounds[id] = { id, start, end: start + L, source: null, strike: null, strikeNote: '', settled: false, close: null };
  return S.fc.rounds[id];
}
const fcPending = {};
function fcOpenStrike(r) {
  if (r.strike != null || fcPending['s' + r.id]) return;
  const now = Date.now();
  if (usingSim()) { if (feed.sim == null) return; r.source = 'sim'; r.strike = feed.sim; r.strikeNote = 'Simulated practice price'; return; }
  if (!liveOk()) return;
  if (now - r.start < 10000) { r.source = 'live'; r.strike = feed.live; r.strikeNote = `Bitcoin price at ${fmtClock(r.start, S.fast)} (${feed.source})`; return; }
  fcPending['s' + r.id] = true;
  candleOpen(r.start).then((p) => { r.source = 'live'; r.strike = p; r.strikeNote = `Bitcoin price at ${fmtClock(r.start, S.fast)} (Coinbase)`; })
    .catch(() => { if (r.strike == null && liveOk()) { r.source = 'live'; r.strike = feed.live; r.strikeNote = 'You joined late: first live price this page saw this round'; } })
    .finally(() => { delete fcPending['s' + r.id]; save(); changed(); });
}
function fcQuote(r) {
  const price = r.source === 'sim' ? feed.sim : (liveOk() ? feed.live : null);
  if (price == null || r.strike == null) return null;
  const secs = Math.max(0, (r.end - Date.now()) / 1000);
  const p = secs <= 0 ? (price > r.strike ? 1 : 0) : normCdf(Math.log(price / r.strike) / (ANNUAL_VOL * Math.sqrt(secs / SEC_PER_YEAR)));
  const fairYes = Math.round(Math.min(MAX_P, Math.max(MIN_P, p)) * 100);
  return { price, fairYes, fairNo: 100 - fairYes, yes: fairYes + FEE_PER_SIDE, no: 100 - fairYes + FEE_PER_SIDE };
}
function fcReward(price) { return Math.round(fcBase() * 100 / price); }
let fcConfirm = null;
function fcMake(side) {
  fcDayReset();
  const r = fcRound(), q = fcQuote(r);
  if (!q || Date.now() >= r.end - fcLock()) return;
  if (S.fc.used >= fcCallsPerDay()) return toast('No free calls left today. More tomorrow. (Tidecaller Tower level adds calls.)', 'bad');
  if (S.fc.calls.some((c) => c.roundId === r.id)) return toast('One call per round. Wait for the next round.', 'bad');
  const price = side === 'yes' ? q.yes : q.no, fair = side === 'yes' ? q.fairYes : q.fairNo;
  S.fc.used++;
  S.fc.calls.unshift({ id: Date.now(), roundId: r.id, side, price, fair, base: fcBase(), btc: q.price, t: Date.now(), status: 'open', sim: r.source === 'sim' });
  S.fc.calls = S.fc.calls.slice(0, 40);
  addXP(5);
  fcConfirm = null;
  toast(`Call made: ${side === 'yes' ? 'YES (above)' : 'NO (not above)'} at ${price}. Result at ${fmtClock(r.end, S.fast)}.`, 'good');
  save(); changed(); render();
}
function fcSettleDue() {
  const now = Date.now();
  for (const r of Object.values(S.fc.rounds)) {
    if (r.settled || now < r.end) continue;
    const calls = S.fc.calls.filter((c) => c.roundId === r.id && c.status === 'open');
    if (!calls.length) { r.settled = true; continue; }
    if (r.source === 'sim') { fcSettle(r, feed.sim, 'Simulated price', true); continue; }
    if (liveOk() && feed.liveAt >= r.end && feed.liveAt - r.end < 15000) { fcSettle(r, feed.live, `Bitcoin price at ${fmtClock(r.end, true)} (${feed.source})`); continue; }
    if (now - r.end > 8000 && !fcPending['c' + r.id] && (!r.lastTry || now - r.lastTry > 10000)) {
      r.lastTry = now; fcPending['c' + r.id] = true;
      candleOpen(r.end).then((p) => { if (!r.settled) fcSettle(r, p, `Bitcoin price at ${fmtClock(r.end, true)} (Coinbase)`); })
        .catch(() => { if (!r.settled && Date.now() - r.end > 180000) fcSettle(r, null, 'No real price was available'); })
        .finally(() => { delete fcPending['c' + r.id]; save(); changed(); });
    }
  }
}
function fcSettle(r, close, note, practice) {
  fcDayReset();
  r.settled = true; r.close = close; r.closeNote = note;
  for (const c of S.fc.calls.filter((x) => x.roundId === r.id && x.status === 'open')) {
    if (close == null || practice) { c.status = 'returned'; S.fc.used = Math.max(0, S.fc.used - 1); c.note = practice ? 'Practice round on a simulated price: no reward, call given back.' : 'No real end price: call given back.'; continue; }
    const winSide = close > r.strike ? 'yes' : 'no';
    c.close = close;
    if (c.side !== winSide) { c.status = 'lost'; c.note = 'Nothing lost: the call was free.'; continue; }
    const fairR = Math.round(c.base * 100 / c.fair), full = Math.round(c.base * 100 / c.price);
    const room = Math.max(0, fcCap() - S.fc.earned.grain);
    const got = Math.min(full, room);
    S.fc.earned = each(S.fc.earned.grain + got);
    gain(each(got)); S.shards += 1;
    const sh = extendShield(SHIELD_FORECAST);
    const shNote = sh ? `+${fmtDur(sh)} shield` : `no shield (max 1 per ${fmtDur(T(SHIELD_CAP_WINDOW))})`;
    S.fc.spreadKept += (fairR - full) * 3;
    c.status = 'won'; c.reward = got; c.capped = got < full;
    c.note = `+${fmt(got)} grain, timber and ore, +1 Shard, ${shNote}.${got < full ? ' (Daily cap reached.)' : ''}`;
    if (c.btc != null) postFeed(`🔮 ${S.name} called Bitcoin right (${c.side.toUpperCase()}) and won ${fmt(got)} of each resource.`, 'fcwin');
    logEvent(`Forecast WON: ${c.note}`, 'good');
  }
  save(); changed();
}

// ======================= Banner chat (local only, AI members) =======================
const CHANNELS = [
  { id: 'general', name: '# general', about: 'Hang out with your banner.' },
  { id: 'war-room', name: '# war-room', about: 'Plans, targets, and troop tips.' },
  { id: 'battle-feed', name: '# battle-feed', about: 'Raids, wipes, revenge and big wins post here by themselves.' },
  { id: 'kingdom', name: '# kingdom', about: 'Everyone, including rival banners.' },
];
const MEMBERS = [
  { name: 'Rook', role: 'Lord' }, { name: 'Sable', role: 'Officer' }, { name: 'Pip', role: 'Recruit' }, { name: 'Juno', role: 'Recruit' },
];
const EMOJIS = ['👍', '😂', '🔥', '😮', '😢', '⚔️'];
const BANNER_NAME = 'The Laurel Watch';
const LINES = {
  general: ['Morning, banner. Who is up?', 'Anyone farming crabs today?', 'Keep your shields up before bed, friends.', 'That Bitcoin round was close.',
    'Tidecaller Tower is worth it. More calls each day.', 'Infirmary saved half my legion last night.', 'Who else picked the loot perk?', 'Coffee and sieges. Good morning.'],
  'war-room': ['{rival} has been raiding all week. Watch your shields.', 'Who wants to teleport on {rival}? Their shield drops soon.',
    'Cavalry crush Shell Crabs. Bring them.', 'Cavalry beat Infantry. Infantry beat Archers. Archers beat Cavalry.', 'Hit them when the shield is down. Surprise sieges hurt.',
    'Upgrade the Infirmary. Wounded can be healed, killed cannot.'],
  kingdom: ['{rival}: Nice Spire, {me}. Shame if something happened to it.', '{rival}: Saltfang never sleeps.', '{rival}: Who wants smoke? Black Reef is ready.',
    '{rival}: Your walls look thin from here.', '{rival}: Good fight yesterday, Laurel Watch. Not good enough.'],
};
const REPLIES = {
  wipe: ['Ouch. Take the Comeback Tailwind and build back.', 'We will get {rival} back. Check the revenge list!', 'Rough one. The infirmary will help.'],
  raid: ['They caught you slipping. Shield up!', 'Revenge list, now. Let us go.'],
  held: ['Held the line! 🔥', 'Walls of marble. Nice.'],
  revenge: ['REVENGE! ⚔️', 'That is how it is done.', 'Ha! They felt that.'],
  revengefail: ['Next time. Train more and try again.', 'Bring counters next time.'],
  fcwin: ['Oracle mode.', 'Called it!'],
  find: ['Whoa, nice find! 💎', 'Lucky! Sell it or keep it?', 'The sea gives back.'],
  levelup: ['Spire is climbing. Nice work.', 'Grats!'],
};
function chatInit() {
  if (S.chat) return;
  S.chat = { msgs: [], nextId: 1, unread: 0, muted: [], filter: true, nextAI: Date.now() + 20e3 };
  postChat('general', 'Rook', `Welcome to ${BANNER_NAME}, ${S.name}! Grab your shield and say hi.`);
  postChat('war-room', 'Sable', 'Tip: hit rivals when their shield is down. Check Army & Raids.');
  postChat('kingdom', 'Captain Brine', 'Captain Brine: Fresh Spires everywhere. Delicious.');
}
function postChat(ch, author, text, kind) {
  if (!S.chat) return;
  const m = { id: S.chat.nextId++, ch, author, text, t: Date.now(), react: {}, mine: [], kind: kind || '' };
  S.chat.msgs.push(m);
  S.chat.msgs = S.chat.msgs.slice(-300);
  if (!(activeTab === 'chat' && chatCh === ch)) S.chat.unread++;
  return m;
}
function postFeed(text, kind) {
  if (!S.chat) return;
  const m = postChat('battle-feed', 'Battle Feed', text, 'feed');
  const rival = (RIVALS.find((r) => text.includes(r.name)) || RIVALS[0]).name;
  const lines = REPLIES[kind];
  if (lines) {
    pendingAI.push({ at: Date.now() + 2500, fn: () => {
      const who = pick(MEMBERS);
      const e1 = pick(EMOJIS); m.react[e1] = (m.react[e1] || 0) + 1;
      m.react['⚔️'] = (m.react['⚔️'] || 0) + (kind === 'revenge' || kind === 'wipe' ? 2 : 0);
      postChat(kind === 'wipe' || kind === 'raid' ? 'war-room' : 'general', who.name, pick(lines).replace('{rival}', rival));
    } });
  }
}
const pendingAI = [];
function aiChatter() {
  const now = Date.now();
  while (pendingAI.length && pendingAI[0].at <= now) { pendingAI.shift().fn(); changed(); }
  if (!S.chat || now < S.chat.nextAI) return;
  S.chat.nextAI = now + (S.fast ? 20e3 : 60e3) + Math.random() * (S.fast ? 25e3 : 90e3);
  const ch = pick(['general', 'general', 'war-room', 'kingdom']);
  const rival = pick(RIVALS);
  const line = pick(LINES[ch]).replace('{rival}', rival.name).replace('{me}', S.name);
  const author = ch === 'kingdom' ? rival.name : pick(MEMBERS).name;
  const m = postChat(ch, author, line.replace(rival.name + ': ', ''));
  if (Math.random() < 0.5) m.react[pick(EMOJIS)] = 1 + Math.floor(Math.random() * 3);
  changed();
}
const BAD_WORDS = ['damn', 'hell', 'crap'];
function filterText(t) { if (!S.chat.filter) return t; let o = t; BAD_WORDS.forEach((w) => { o = o.replace(new RegExp('\\b' + w + '\\b', 'gi'), '*'.repeat(w.length)); }); return o; }
function sendChat(text) {
  text = text.trim().slice(0, 300); if (!text) return;
  postChat(chatCh, S.name, text);
  if (Math.random() < 0.6) pendingAI.push({ at: Date.now() + 3000, fn: () => postChat(chatCh, pick(MEMBERS).name, pick(['Ha, true.', 'Agreed!', 'Let us go!', '👍', 'Good call.', 'Same here.'])) });
  save(); changed(); render();
}
function toggleReact(id, e) {
  const m = S.chat.msgs.find((x) => x.id === id); if (!m) return;
  if (m.mine.includes(e)) { m.mine = m.mine.filter((x) => x !== e); m.react[e] = Math.max(0, (m.react[e] || 1) - 1); }
  else { m.mine.push(e); m.react[e] = (m.react[e] || 0) + 1; }
  save(); changed(); render();
}
function roleOf(author) {
  if (author === S.name) return 'You';
  const mem = MEMBERS.find((m) => m.name === author); if (mem) return mem.role;
  if (RIVALS.some((r) => r.name === author)) return 'Rival';
  return '';
}


// ======================= Market (in-game Gold only, 5% house cut) =======================
const MARKET_CUT = 0.05, LOT = 100;
const MKT_BASE = { grain: 10, timber: 12, ore: 15 }; // Gold per 100 units
const TRADERS = ['Captain Brine', 'Vela Stormcut', 'Old Harrow', 'Kestrel'];
function mktInit() {
  if (S.market) return;
  S.gold = S.gold || 50;
  S.market = { hist: { grain: [10], timber: [12], ore: [15] }, next: Date.now(), cutKept: 0, log: [] };
}
function mktStep() {
  if (!S.market || Date.now() < S.market.next) return;
  S.market.next = Date.now() + (S.fast ? 10e3 : 60e3);
  RES.forEach((r) => {
    const h = S.market.hist[r], last = h[h.length - 1];
    // Random drift that is pulled back toward the base price.
    const nxt = Math.max(2, Math.round((last + (MKT_BASE[r] - last) * 0.2 + (Math.random() - 0.5) * 3) * 10) / 10);
    h.push(nxt); if (h.length > 12) h.shift();
  });
  if (activeTab === 'market') changed();
}
const mktPrice = (r) => S.market.hist[r][S.market.hist[r].length - 1];
const mktBuy = (r) => Math.ceil(mktPrice(r) * (1 + MARKET_CUT) * 10) / 10;
const mktSell = (r) => Math.floor(mktPrice(r) * (1 - MARKET_CUT) * 10) / 10;
function trade(r, side) {
  const who = pick(TRADERS);
  if (side === 'buy') {
    const cost = mktBuy(r); if (S.gold < cost) return toast(`Not enough Gold. 100 ${r} costs ${cost} Gold.`, 'bad');
    S.gold = Math.round((S.gold - cost) * 10) / 10; S.res[r] += LOT; S.market.cutKept += cost - mktPrice(r);
    S.market.log.unshift(`Bought 100 ${r} from ${who} for ${cost} Gold.`);
  } else {
    if (S.res[r] < LOT) return toast(`You need 100 ${r} to sell.`, 'bad');
    const got = mktSell(r); S.res[r] -= LOT; S.gold = Math.round((S.gold + got) * 10) / 10; S.market.cutKept += mktPrice(r) - got;
    S.market.log.unshift(`Sold 100 ${r} to ${who} for ${got} Gold.`);
  }
  S.market.log = S.market.log.slice(0, 8);
  toast(S.market.log[0], 'good'); save(); changed(); render();
}
function viewMarket() {
  const spark = (h) => { const mx = Math.max(...h), mn = Math.min(...h), w = 160, ht = 40;
    const pts = h.map((v, i) => `${(i / Math.max(1, h.length - 1) * w).toFixed(1)},${(ht - (mx === mn ? ht / 2 : (v - mn) / (mx - mn) * ht)).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${ht + 4}" role="img" aria-label="price history"><polyline fill="none" stroke="#8c1c13" stroke-width="3" points="${pts}"/></svg>`; };
  return `<div class="card"><h2>⚖️ Market</h2><p>Trade 100 units at a time with AI rival traders for in-game <b>Gold</b>. Gold is play money only: it can't be bought, cashed out, or traded for prizes.</p>
    <p class="big">Your Gold: ${fmt(S.gold)}</p>
    <p><b>House cut: ${MARKET_CUT * 100}%.</b> You buy at the market price + 5% and sell at the market price − 5%. House cut collected so far: ${S.market.cutKept.toFixed(1)} Gold. Prices change every ${S.fast ? '10 seconds' : 'minute'}.</p>
    <table><tr><th>Item</th><th>Market price (per 100)</th><th>Last 12 prices</th><th></th></tr>${RES.map((r) => `<tr><td><b>${r[0].toUpperCase() + r.slice(1)}</b><br><span class="small">you have ${fmt(S.res[r])}</span></td>
      <td class="big">${mktPrice(r)}</td><td>${spark(S.market.hist[r])}<div class="small">${S.market.hist[r].join(' · ')}</div></td>
      <td>${btn(`Buy 100<br><span class="small" style="color:inherit">${mktBuy(r)} Gold</span>`, 'trade', [r, 'buy'], '', S.gold < mktBuy(r))} ${btn(`Sell 100<br><span class="small" style="color:inherit">${mktSell(r)} Gold</span>`, 'trade', [r, 'sell'], 'alt', S.res[r] < LOT)}</td></tr>`).join('')}</table>
    <p class="small">Rare finds from sea monsters are sold below. They can't be bought.</p>
    <h3>Recent trades</h3>${S.market.log.length ? '<ul>' + S.market.log.map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>' : '<p class="small">None yet.</p>'}</div>${inventoryPanel()}`;
}


// ======================= Rare finds (sea-monster drops) =======================
// One roll per sea-monster win. Gameplay only: drops can never be bought with Gems, Gold or the shop.
const DROP_TIERS = [
  { id: 'common',    name: 'Common',    pct: 60,  items: ['Sea-salt Pearl', 'Kelp Rope', 'Bronze Scale'], gold: 2 },
  { id: 'uncommon',  name: 'Uncommon',  pct: 25,  items: ['Coral Gladius Hilt', 'Tide Glass'], gold: 6 },
  { id: 'rare',      name: 'Rare',      pct: 10,  items: ['Serpent-Scale Shield', 'Ray-Sting Spear'], gold: 20 },
  { id: 'epic',      name: 'Epic',      pct: 4,   items: ['Stormwyrm Fang'], gold: 75 },
  { id: 'legendary', name: 'Legendary', pct: 0.9, items: ['Crown of the Drowned Legion'], gold: 400 },
  { id: 'mythic',    name: 'Mythic',    pct: 0.1, items: ['Heart of the Abyss'], gold: 3000 },
];
const PITY_N = 10; // after 10 wins in a row with nothing Rare or better, the next drop is Rare or better
const RARE_IDX = 2;
function dropsInit() { if (!S.drops) S.drops = { dry: 0, kills: 0, byTier: {}, log: [] }; if (!S.inv) S.inv = {}; }
function rollDrop() {
  dropsInit();
  const pity = S.drops.dry >= PITY_N;
  const pool = pity ? DROP_TIERS.slice(RARE_IDX) : DROP_TIERS;
  const total = pool.reduce((a, t) => a + t.pct, 0);
  let x = Math.random() * total, tier = pool[pool.length - 1];
  for (const t of pool) { if (x < t.pct) { tier = t; break; } x -= t.pct; }
  const item = pick(tier.items);
  const ti = DROP_TIERS.indexOf(tier);
  S.drops.kills++;
  S.drops.dry = ti >= RARE_IDX ? 0 : S.drops.dry + 1;
  S.drops.byTier[tier.id] = (S.drops.byTier[tier.id] || 0) + 1;
  S.inv[item] = (S.inv[item] || 0) + 1;
  S.drops.log.unshift({ item, tier: tier.id, pity, t: Date.now() });
  S.drops.log = S.drops.log.slice(0, 10);
  if (ti >= RARE_IDX) postFeed(`💎 ${S.name} found ${/^[AEIOU]/.test(tier.name) ? "an" : "a"} ${tier.name.toUpperCase()} ${item}${pity ? ' (pity drop)' : ''}!`, 'find');
  return { item, tier, pity };
}
const itemTier = (item) => DROP_TIERS.find((t) => t.items.includes(item));
const itemSell = (item) => Math.floor(itemTier(item).gold * (1 - MARKET_CUT) * 10) / 10;
function sellItem(item) {
  if (!S.inv[item]) return;
  const got = itemSell(item);
  S.inv[item]--; if (!S.inv[item]) delete S.inv[item];
  S.gold = Math.round(((S.gold || 0) + got) * 10) / 10;
  S.market.cutKept += itemTier(item).gold - got;
  S.market.log.unshift(`Sold ${item} (${itemTier(item).name}) to ${pick(TRADERS)} for ${got} Gold.`);
  S.market.log = S.market.log.slice(0, 8);
  toast(S.market.log[0], 'good'); save(); changed(); render();
}
function oddsPanel() {
  dropsInit();
  return `<div class="card" id="oddsPanel"><h2>🎲 Rare finds: exact odds</h2>
    <p>Every sea-monster win gives <b>one</b> find. Finds come only from play. They can <b>never</b> be bought with Gems, Gold or anything in the shop.</p>
    <table><tr><th>Tier</th><th>Chance</th><th>Items</th><th>Sells for</th><th>You found</th></tr>${DROP_TIERS.map((t) =>
      `<tr><td><span class="tier ${t.id}">${t.name}</span></td><td><b>${t.pct}%</b>${t.pct < 1 ? ` (1 in ${fmt(100 / t.pct)})` : ''}</td><td class="small">${t.items.join(', ')}</td><td>${t.gold} Gold base</td><td>${S.drops.byTier[t.id] || 0}</td></tr>`).join('')}</table>
    <p><b>Pity rule:</b> after ${PITY_N} wins in a row with nothing Rare or better, your next find is <b>guaranteed Rare or better</b> (rolled among Rare, Epic, Legendary and Mythic with the same relative odds: Rare 66.7%, Epic 26.7%, Legendary 6%, Mythic 0.67%). Getting Rare or better resets the count.</p>
    <p><b>Real long-run chance of Rare or better: about 18% per find</b> (15% from the table, plus the pity guarantee).</p>
    <p class="big">Dry streak: ${S.drops.dry} of ${PITY_N}${S.drops.dry >= PITY_N ? ' → next find is Rare or better!' : ''}</p>
    <p class="small">Rolls use your browser's random number generator. Nothing is changed behind the scenes.</p>
    ${S.drops.log.length ? '<h3>Recent finds</h3><ul>' + S.drops.log.map((d) => `<li><span class="tier ${d.tier}">${DROP_TIERS.find((t) => t.id === d.tier).name}</span> ${esc(d.item)}${d.pity ? ' (pity)' : ''}</li>`).join('') + '</ul>' : ''}</div>`;
}
function inventoryPanel() {
  dropsInit();
  const items = Object.keys(S.inv).sort((a, b) => DROP_TIERS.indexOf(itemTier(b)) - DROP_TIERS.indexOf(itemTier(a)));
  return `<div class="card"><h2>🎒 Your finds (sell for Gold)</h2><p class="small">Sell price = base value − 5% house cut. Finds can be sold here but never bought.</p>${items.length
    ? `<table><tr><th>Item</th><th>Tier</th><th>You have</th><th></th></tr>${items.map((it) => `<tr><td><b>${esc(it)}</b></td><td><span class="tier ${itemTier(it).id}">${itemTier(it).name}</span></td><td>${S.inv[it]}</td><td>${btn(`Sell 1<br><span class="small" style="color:inherit">${itemSell(it)} Gold</span>`, 'sellItem', [it], 'alt')}</td></tr>`).join('')}</table>`
    : '<p>No finds yet. Beat sea monsters to find items.</p>'}</div>`;
}

// ======================= Rendering =======================
let activeTab = 'isle', chatCh = 'general', trainSel = { type: 'inf', tier: 0 }, toastTimer = null, awaySummary = null;
function toast(text, kind) {
  const el = $('toast'); el.className = 'toast ' + (kind || ''); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 12000);
}
const until = (ts) => `<span data-until="${ts}">${fmtDur(ts - Date.now())}</span>`;
const btn = (label, act, args, cls, dis) => `<button class="btn ${cls || ''}" data-act="${act}" data-args='${esc(JSON.stringify(args || []))}'${dis ? ' disabled' : ''}>${label}</button>`;
const costText = (c) => `${fmt(c.grain)} grain, ${fmt(c.timber)} timber, ${fmt(c.ore)} ore`;

function renderTop() {
  $('rGrain').textContent = fmt(S.res.grain); $('rTimber').textContent = fmt(S.res.timber); $('rOre').textContent = fmt(S.res.ore);
  $('rGems').textContent = fmt(S.gems); $('rGold').textContent = fmt(S.gold || 0); $('rShards').textContent = fmt(S.shards);
  $('fastTag').hidden = !S.fast;
  const sb = $('shieldBar'), now = Date.now();
  if (shieldUp()) { sb.className = 'shield-bar up'; sb.innerHTML = `🛡 Shield up: ${fmtDur(S.shieldUntil - now)} left. Rivals cannot raid you.`; }
  else {
    const r = nextRival(), atk = rivalAttack(r, S.b.spire), def = defensePower(), out = raidOutcome(atk, def);
    sb.className = 'shield-bar down';
    sb.innerHTML = `⚠ NO SHIELD. Next raid check in ${fmtDur(S.raid.next - now)}: ${esc(r.name)} (attack ${fmt(atk)}) vs your defense ${fmt(def)} → ${out === 'held' ? 'you would HOLD' : out === 'wipe' ? 'you would be WIPED' : 'you would LOSE half your resources'}.`;
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === activeTab || (activeTab === 'battle' && b.dataset.tab === 'army')));
  const badge = $('chatBadge'); const u = S.chat ? S.chat.unread : 0; badge.hidden = !u; badge.textContent = u;
}

function viewFaction() {
  return `<div class="card laurel"><h2>Choose your faction</h2><p>Pick who you lead. Each has a home region and one special unit. You can only pick once in this demo.</p>
  <label class="label" for="nameIn">Your name</label><br><input id="nameIn" type="text" maxlength="20" value="${esc(S.name)}"><div class="grid3">${
    Object.entries(FACTIONS).map(([k, f]) => `<div class="bld faction"><div class="big">${f.icon} ${f.name}</div><p>${f.desc}</p>
      <p><b>Home region:</b> ${f.region}</p><p><b>Special unit:</b> ${f.unit}</p><p><b>Bonus:</b> ${f.extra}</p>${btn('Lead the ' + f.name.split(' ').slice(-1)[0], 'pickFaction', [k])}</div>`).join('')
  }</div></div>`;
}

const TROOP_TIP = "Warning: your defense can't stop the next raid. Train troops in Army & Raids so you don't get wiped.";
// Same trigger as Da Angel's simulator: Spire 5+ AND the strongest rival (full strength, not weakened) at your
// Spire level would WIPE you, i.e. its attack >= 2x your current home defense (wall + perks + troops at home).
const TIP_MIN_SPIRE = 5;
const worstRaidAttack = (L = S.b.spire) => Math.round(260 * Math.pow(1.8, L - 1) * Math.max(...RIVALS.map((r) => r.mult)));
const showTroopTip = () => S.b.spire >= TIP_MIN_SPIRE && raidOutcome(worstRaidAttack(), defensePower()) === 'wipe';
// Upgrade button, or "Line up next" when both builders are busy and nothing is lined up yet.
function upBtns(key, u, label, tag) {
  const busy = u.block === 'Both builders are busy.', same = u.block === 'Already upgrading.';
  if ((busy || same) && S.queue.length >= BUILDERS) {
    const qi = queueInfo(key);
    if (!qi.block) return `${btn(`Line up next (level ${qi.to})`, 'queueNext', [key], 'alt')} <${tag} class="small">Both builders are busy. Starts by itself when one is free; paid then.</${tag}>`;
    if (busy) return `${btn(label, 'startUpgrade', [key], '', true)} <${tag} class="small no">${S.nextUp ? 'Both builders are busy and one upgrade is already lined up.' : qi.block}</${tag}>`;
  }
  return `${btn(label, 'startUpgrade', [key], '', !!u.block)} ${u.block ? `<${tag} class="${tag === 'div' ? 'small ' : ''}no">${u.block}</${tag}>` : ''}`;
}
function viewIsle() {
  const now = Date.now(); let h = '';
  if (awaySummary) h += `<div class="banner"><h3>While you were away (${fmtDur(awaySummary.ms)})</h3><p>+${fmt(awaySummary.gain.grain)} grain, +${fmt(awaySummary.gain.timber)} timber, +${fmt(awaySummary.gain.ore)} ore${awaySummary.ms > OFFLINE_CAP ? ' (offline earnings stop after 12 hours)' : ''}.</p>${awaySummary.events.length ? '<ul>' + awaySummary.events.slice(0, 8).map((e) => `<li class="${e.kind === 'bad' ? 'no' : e.kind === 'good' ? 'ok' : ''}">${esc(e.text)}</li>`).join('') + '</ul>' : ''}${btn('OK', 'dismissAway', [], 'alt')}</div>`;
  if (S.perkChoices.length) {
    const lvl = S.perkChoices[0];
    h += `<div class="banner good"><h3>Spire level ${lvl}: pick 1 perk</h3><div class="perk-row">${perkOptions(lvl).map((k) => `<button data-act="choosePerk" data-args='[${lvl},"${k}"]'><b>${PERKS[k].name}</b><br><span class="small">${PERKS[k].desc}</span></button>`).join('')}</div></div>`;
  }
  boostText().forEach((b) => { h += `<div class="banner good">⛵ ${b}</div>`; });
  if (S.repairUntil > now) h += `<div class="banner bad">🔧 Buildings are being repaired after a raid. No production for ${until(S.repairUntil)}.</div>`;
  if (S.daily.gift !== today()) h += `<div class="banner">🎁 Your daily gift is ready. ${btn('Collect daily gift', 'claimGift')}</div>`;
  if (showTroopTip()) h += `<div class="banner bad" id="troopTip">⚠️ ${TROOP_TIP}</div>`;
  const sp = upgradeInfo('spire'), f = S.faction && FACTIONS[S.faction];
  const pre = S.b.spire < MAX_LEVEL ? prereqFor(S.b.spire + 1) : null;
  h += `<div class="card spire laurel"><div class="label">${f ? f.icon + ' ' + f.name + ' · ' + f.region : ''}</div><h2>🏛️ The Spire: level ${S.b.spire} of ${MAX_LEVEL}</h2>
    <p>The Spire is your castle. No building can be a higher level than the Spire.</p>${S.b.spire < MAX_LEVEL ? `
    <p><b>Next level needs every building at level ${S.b.spire}:</b> ${BKEYS.map((k) => `<span class="${S.b[k] >= S.b.spire ? 'ok' : 'no'}">${BUILDINGS[k].name} ${S.b[k] >= S.b.spire ? '✔' : '(' + S.b[k] + ')'}</span>`).join(' · ')}<br>
    <b>Cost:</b> ${costText(sp.cost)}<br><b>Time:</b> ${fmtDur(sp.time)}</p>
    ${upBtns('spire', sp, 'Upgrade the Spire', 'span')}` : '<p class="ok">Max level!</p>'}</div>`;
  const ns = nextUpStatus();
  h += `<div class="card" id="buildersCard"><h2>Builders (${S.queue.length} of ${BUILDERS} busy)</h2>${S.queue.length ? S.queue.map((q, i) =>
    `<p>${bName(q.key)} → level ${q.to}: <b>${until(q.end)}</b> left. ${btn(`Finish now (<span data-gems="${q.end}">${finishNowCost(q)}</span> Gem${finishNowCost(q) === 1 ? '' : 's'})`, 'finishNow', [i], 'alt')}</p>`).join('') : '<p>Both builders are free. Pick something to upgrade.</p>'}
    <h3>Next up (${S.nextUp ? 1 : 0} of ${NEXT_SLOTS})</h3>${S.nextUp ? `<p id="nextUp"><b>${bName(S.nextUp.key)} → level ${S.nextUp.to}</b>. Cost ${costText(ns.cost)}, paid when it starts.<br>
      <span id="nextUpWhy" class="${ns.poor ? 'no' : 'small'}">${esc(ns.why || 'Starting now…')}</span><br>${btn('Cancel lined-up upgrade', 'cancelNext', [], 'alt')}</p>`
      : `<p class="small">When both builders are busy, you can line up ONE more upgrade. It starts by itself when a builder is free, if you can pay for it then. Nothing is paid until it starts.</p>`}</div>`;
  h += `<div class="grid2">${BKEYS.map((k) => {
    const u = upgradeInfo(k), B = BUILDINGS[k];
    const prod = B.makes ? `<br>Makes <b>${fmt(prodPerHour(B.makes))}</b> ${B.makes} per hour.` : '';
    return `<div class="bld"><div class="lvl">${B.name}: level ${S.b[k]}</div><div class="small">${B.what}${prod}</div>${S.b[k] < MAX_LEVEL ? `
      <p class="small">Upgrade: ${costText(u.cost)}. Time ${fmtDur(u.time)}.</p>${upBtns(k, u, 'Upgrade', 'div')}` : '<p class="ok">Max level</p>'}</div>`;
  }).join('')}</div>`;
  h += `<div class="card"><h2>Your perks</h2><p>${S.perks.length ? S.perks.map((k) => PERKS[k].name).join(', ') : 'None yet. You pick one each time the Spire levels up.'}</p></div>`;
  return h;
}

const SHIELD_RULE = () => `Lose a raid and you get an automatic ${fmtDur(T(SHIELD_AFTER_LOSS))} shield. Everyone can get at most 1 new shield every ${fmtDur(T(SHIELD_CAP_WINDOW))}, from any source (daily gift, Forecast win, Spire level-up, or Gems). The shield after a lost raid always comes, but it counts as your 1 shield.`;
function viewArmy() {
  const now = Date.now(), L = S.b.spire; let h = '';
  if (lastReport) h += `<div class="banner ${lastReport.won ? 'good' : 'bad'}"><h3>Last battle report</h3><p>${esc(lastReport.msg)}</p></div>`;
  const def = defensePower();
  h += `<div class="card"><h2>Defense</h2><p class="big">Your defense: ${fmt(def)}</p><p>Spire wall ${fmt(Math.round(wallDefense(L) * (1 + 0.25 * hasPerk('wall') + fBonus('wall'))))} + troops at home ${fmt(armyPower(null))}.</p>
    <h3>Raid rules (exact, no dice)</h3><ul>
    <li>Every ${fmtDur(T(RAID_EVERY))}, a rival checks your Spire. Next check in <b>${until(S.raid.next)}</b>.</li>
    <li>If your shield is up, nothing happens.</li>
    <li>If it is down, the next rival in line attacks: <b>${esc(nextRival().name)}</b> with attack <b>${fmt(rivalAttack(nextRival(), L))}</b>.${S.raid.grudge ? ' (They are first because you hit them.)' : ''}</li>
    <li>Defense ≥ attack: you hold, lose 10% of troops, and take loot from them.</li>
    <li>Attack bigger than defense: they take half your stored resources, 30% of your troops fall, and buildings stop for ${fmtDur(T(REPAIR_TIME / 3))}. You then get an automatic ${fmtDur(T(SHIELD_AFTER_LOSS))} shield.</li>
    <li>Attack double your defense or more: <b>WIPE</b>. All stored resources gone, every troop at home falls, buildings stop for ${fmtDur(T(REPAIR_TIME))}. Then you get a Comeback Tailwind (${COMEBACK_MULT}x for ${fmtDur(T(COMEBACK_TIME))}), starter resources, 30 troops and an automatic ${fmtDur(T(SHIELD_AFTER_LOSS))} shield.</li>
    <li>Fallen troops: when defending, 70% are wounded (go to the Infirmary) and 30% are killed. Attacking: 30% wounded, 70% killed. Losing a siege: 10% wounded. If the Infirmary is full, the extra wounded die.</li>
    <li>Attacking anyone drops your own shield. Whoever you hit raids you next.</li></ul>
    <p>Shields: ${shieldUp() ? `<span class="ok">up for ${until(S.shieldUntil)}</span>` : '<span class="no">DOWN</span>'}. Earn them from the daily gift (${fmtDur(T(SHIELD_DAILY))}), Forecast wins (${fmtDur(T(SHIELD_FORECAST))}) and Spire level-ups (${fmtDur(T(SHIELD_LEVELUP))}), or with Gems in the demo shop.</p>
    <p class="banner" id="shieldRule"><b>Shield rule:</b> ${SHIELD_RULE()} ${shieldAllowed() ? '<span class="ok">You can get a shield now.</span>' : `<span class="no">Next shield allowed in ${until(shieldReadyAt())}.</span>`}</p>
    <p class="small">The Isle shows a warning from Spire level ${TIP_MIN_SPIRE} when the strongest rival (attack ${fmt(worstRaidAttack())} now) would wipe you: its attack is double your defense (${fmt(defensePower())}) or more.</p></div>`;
  // Troops
  h += `<div class="card"><h2>Troops</h2><p class="small">Cavalry beat Infantry. Infantry beat Archers. Archers beat Cavalry.</p><table><tr><th>Type</th><th>Tier 1</th><th>Tier 2</th><th>Tier 3</th><th>Wounded</th></tr>${
    TKEYS.map((t) => `<tr><td>${ICON[t]} ${TROOPS[t].name}</td>${S.army[t].map((n) => `<td>${fmt(n)}</td>`).join('')}<td>${fmt(S.wounded[t].reduce((a, b) => a + b, 0))}</td></tr>`).join('')}</table>`;
  h += `<h3>Train troops</h3>${S.train ? `<p>Training ${S.train.n} tier ${S.train.tier + 1} ${TROOPS[S.train.type].name}: <b>${until(S.train.end)}</b> left.</p>` : ''}
    <div class="btn-row">${TKEYS.map((t) => `<button class="btn ${trainSel.type === t ? '' : 'alt'}" data-act="selTrain" data-args='["${t}",${trainSel.tier}]'>${ICON[t]} ${TROOPS[t].name}</button>`).join('')}</div>
    <div class="btn-row">${[0, 1, 2].map((tier) => `<button class="btn ${trainSel.tier === tier ? '' : 'alt'}" data-act="selTrain" data-args='["${trainSel.type}",${tier}]' ${S.b.barracks < TIER_UNLOCK[tier] ? 'disabled' : ''}>Tier ${tier + 1} (power ${T_POWER[tier]})${S.b.barracks < TIER_UNLOCK[tier] ? ' – Barracks ' + TIER_UNLOCK[tier] : ''}</button>`).join('')}</div>
    <div class="btn-row">${[10, 50, 100].map((n) => btn(`Train ${n}<br><span class="small" style="color:inherit">${costText(trainCost(trainSel.tier, n))}</span>`, 'startTrain', [trainSel.type, trainSel.tier, n], '', !!S.train || !canAfford(trainCost(trainSel.tier, n)))).join('')}</div></div>`;
  // Infirmary
  h += `<div class="card"><h2>⚕️ Infirmary (level ${S.b.infirmary})</h2><p>Wounded: <b>${fmt(woundedCount())} of ${fmt(infCap())}</b> beds. Heals ${fmt(healPerHour())} troops per hour for free. Healed so far: ${fmt(S.healedTotal)}.</p>
    ${woundedCount() ? btn('Heal everyone now (half training cost)', 'healNow', [], 'alt') : ''}</div>`;
  // Monsters
  h += `<div class="card"><h2>🌊 Sea monsters</h2><p class="small">Monsters never attack you. Fight them for loot. Auto-resolve: you win if your power (with counters) is at least theirs.</p>`;
  for (let lvl = 1; lvl <= Math.min(10, L + 2); lvl++) {
    const m = monster(lvl), mine = armyPower(m.kind.like), back = (S.monsters[lvl] || 0) > now;
    const strong = TKEYS.find((t) => TROOPS[t].beats === m.kind.like);
    h += `<div class="bld" style="margin-bottom:10px"><b>Level ${lvl} ${m.kind.name}</b> · power ${fmt(m.power)} · loot ${fmt(m.loot)} each${m.gems ? ` + ${m.gems} Gems` : ''}<br>
      <span class="small">${m.kind.note} Best: ${TROOPS[strong].name}. Your power vs it: <b class="${mine >= m.power ? 'ok' : 'no'}">${fmt(mine)}</b>.</span><br>
      ${back ? `<span class="small">Back in ${until(S.monsters[lvl])}</span>` : btn('Fight on the grid', 'gridMonster', [lvl]) + ' ' + btn('Auto-resolve', 'autoMonster', [lvl], 'alt')}</div>`;
  }
  h += '</div>';
  h += oddsPanel();
  // Hunt
  h += `<div class="card"><h2>🎯 Teleport and hunt</h2><p>Teleports: <b>${S.tele.tokens}</b> (1 more with each daily gift). ${S.tele.cooldownUntil > now ? `Cooldown: ${until(S.tele.cooldownUntil)}.` : 'Ready.'}</p>
    <p class="small">Teleport your Spire next to a rival. If their shield is up, they get a ${fmtDur(Math.max(30e3, T(ALERT_TIME)))} warning. If their shield is DOWN when you land, you get a surprise siege: their defense counts 23% less for ${fmtDur(Math.max(30e3, T(SURPRISE_TIME)))}. Win = loot and damaged buildings. Double their defense = you WIPE them.</p>
    <table><tr><th>Rival</th><th>Attack / Defense</th><th>Shield</th><th></th></tr>${RIVALS.map((r) => {
      const sh = rivalShield(r), near = S.tele.near === r.id, st = S.rivals[r.id] || {};
      let act;
      if (!near) act = btn('Teleport', 'teleport', [r.id], 'alt', S.tele.cooldownUntil > now || S.tele.tokens < 1);
      else if (S.tele.alertUntil > now) act = `<b>You are next door.</b> On alert: ${until(S.tele.alertUntil)}`;
      else if (sh.up) act = `<b>You are next door.</b> Wait for their shield.`;
      else act = `<b>${S.tele.surpriseUntil > now ? 'SURPRISE! ' + until(S.tele.surpriseUntil) : 'Shield down!'}</b><br>${btn('Siege (grid)', 'gridHunt', [r.id])} ${btn('Auto', 'autoHunt', [r.id], 'alt')}`;
      return `<tr><td><b>${esc(r.name)}</b><br><span class="small">${r.banner}${st.weakUntil > now ? ' · damaged' : ''}${st.killed ? ` · lost ${fmt(st.killed)} killed, ${fmt(st.wounded || 0)} wounded` : ''}</span></td><td>${fmt(rivalAttack(r, L))} / ${fmt(rivalDefense(r, L))}</td>
        <td>${sh.up ? `🛡 ${until(sh.until)}` : `<span class="no">down ${until(sh.until)}</span>`}</td><td>${act}</td></tr>`;
    }).join('')}</table></div>`;
  // Revenge
  const rv = S.revenge.filter((e) => e.out !== 'held');
  h += `<div class="card"><h2>⚔️ Revenge list</h2>${rv.length ? rv.map((e) => {
    const r = RIVALS.find((x) => x.id === e.rival);
    return `<div class="bld" style="margin-bottom:10px"><b>${esc(r.name)}</b> ${e.out === 'wipe' ? '<span class="no">WIPED you</span>' : '<span class="no">raided you</span>'} at ${fmtClock(e.t)}. Took ${fmt(e.took.grain)} grain, ${fmt(e.took.timber)} timber, ${fmt(e.took.ore)} ore.
      ${e.loss ? `<br><span class="small">Your troops: wounded ${fmt(e.loss.wounded)}, killed ${fmt(e.loss.killed)}, healed ${fmt(e.loss.healed)}. Theirs: wounded ${fmt(e.rivalLoss.wounded)}, killed ${fmt(e.rivalLoss.killed)}.</span>` : ''}
      <br>Their defense: ${fmt(rivalDefense(r, L))}. Your army: ${fmt(armyPower(null))}.<br>
      ${e.done ? '<span class="small">Counter-raid used.</span>' : btn('Counter-raid (grid)', 'gridCounter', [e.id]) + ' ' + btn('Counter-raid (auto)', 'autoCounter', [e.id], 'alt')}
      ${e.teleUsed ? '' : btn('Revenge teleport (free)', 'revengeTele', [e.rival, e.id], 'alt')}</div>`;
  }).join('') : '<p>Nobody has raided you yet.</p>'}</div>`;
  return h;
}

function viewBattle() {
  if (!battle) return '<div class="card">No battle.</div>';
  const b = battle, ctx = b.ctx;
  const sel = b.sel && b.units.find((u) => u.id === b.sel);
  let grid = '<table class="grid">';
  for (let r = 0; r < ROWS; r++) {
    grid += '<tr>';
    for (let c = 0; c < COLS; c++) {
      const u = unitAt(c, r), hill = b.hills.has(c + ',' + r);
      let cls = hill ? 'hill' : '';
      if (sel && !u && !b.moved[sel.id] && dist(sel, { c, r }) <= MOVE[sel.type]) cls += ' canmove';
      if (sel && u && u.side === 'ai' && dist(sel, u) <= RANGE[sel.type]) cls += ' canhit';
      if (u) cls += ' ' + u.side + (sel === u ? ' sel' : '') + (b.acted[u.id] ? ' done' : '');
      grid += `<td><button class="cell ${cls}" data-act="gridClick" data-args="[${c},${r}]" aria-label="${u ? (u.side === 'me' ? 'Your ' : 'Enemy ') + TROOPS[u.type].name : hill ? 'hill' : 'empty'}">${u ? `${ICON[u.type]}<span>${fmt(u.hp)}</span>` : hill ? '⛰' : ''}</button></td>`;
    }
    grid += '</tr>';
  }
  grid += '</table>';
  return `<div class="card"><h2>⚔️ Battle: ${esc(ctx.title)} · turn ${b.turn} of 12</h2>
    <p class="small">${esc(ctx.rule)}</p>
    <div class="triangle" aria-label="Counter triangle"><b>Counter triangle</b><div>🐎 Cavalry <b>beat</b> 🛡 Infantry → 🛡 Infantry <b>beat</b> 🏹 Archers → 🏹 Archers <b>beat</b> 🐎 Cavalry</div></div>
    <p><b>How to play:</b> 1) Tap one of your <span class="tag me">blue</span> units. 2) Tap a <span class="tag mv">green</span> square to move, or a <span class="tag hit">red-ringed</span> enemy to attack. Each unit can move once and attack once. 3) Press <b>End turn</b>.</p>
    <p class="small">🛡 Infantry: move 1, hit next to them. 🐎 Cavalry: move 2, hit next to them. 🏹 Archers: move 1, shoot 3 squares. Counter = +50% damage, wrong matchup = -30%. ⛰ Hill = +25% damage. Flank (a friend also next to the target) = +25%. Numbers are strength left.</p>
    ${grid}
    <div class="btn-row">${btn('End turn', 'endTurn')} ${btn(`Auto-resolve (you ${ctx.kind === 'monster' ? (ctx.myPower >= ctx.enemyPower ? 'WIN' : 'LOSE') : (ctx.myPower > ctx.enemyPower ? 'WIN' : 'LOSE')}: ${fmt(ctx.myPower)} vs ${fmt(ctx.enemyPower)})`, 'autoBattle', [], 'alt')} ${btn('Retreat', 'retreat', [], 'bad')}</div>
    <h3>What happened</h3><ul>${b.log.slice(0, 8).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
}

function viewForecast() {
  fcDayReset();
  const r = fcRound(), q = fcQuote(r), now = Date.now(), locked = now >= r.end - fcLock();
  const left = fcCallsPerDay() - S.fc.used, made = S.fc.calls.find((c) => c.roundId === r.id);
  const sim = usingSim();
  let h = `<div class="card"><h2>🔮 Forecast: Bitcoin up or down?</h2>
    <p class="banner" style="margin:0 0 10px">Free to play. Calls cost nothing. Wins pay <b>in-game resources only</b>. No real money, no cash-out, no prizes.</p>
    <div class="label">Bitcoin price now</div><div class="price" id="fcPrice">${fmtUSD(sim ? feed.sim : feed.live)}</div>
    <div class="small" id="fcSource">${sim ? '<b class="no">SIMULATED practice price. Not real. Practice rounds pay no reward.</b>' : liveOk() ? 'Live from ' + feed.source : 'Getting the live price…'}</div><hr>
    <div class="grid2"><div><div class="label">Start price (the line)</div><div class="big">${fmtUSD(r.strike)}</div><div class="small">${esc(r.strikeNote)}</div></div>
    <div><div class="label">Time left</div><div class="big">${until(r.end)}</div><div class="small">Round ends ${fmtClock(r.end, S.fast)} (${S.fast ? '1-minute fast rounds' : '15-minute rounds'})</div></div></div>
    <p class="big" id="fcDiff"></p></div>`;
  h += `<div class="card"><h2>${r.strike != null ? `Will Bitcoin be above ${fmtUSD(r.strike)} at ${fmtClock(r.end, S.fast)}?` : 'Waiting for the start price…'}</h2>
    <p>Free calls left today: <b>${left} of ${fcCallsPerDay()}</b> (3 + Tidecaller Tower level). Earned today: <b>${fmt(S.fc.earned.grain)} of ${fmt(fcCap())}</b> of each resource (daily cap).</p>
    ${made ? `<p class="ok">You made your call this round: ${made.side.toUpperCase()} at ${made.price}. Result at ${fmtClock(r.end, S.fast)}.</p>` : ''}
    <div class="bet-row"><button class="btn-yes" data-act="fcAsk" data-args='["yes"]' id="fcYes" ${!q || locked || made || left <= 0 ? 'disabled' : ''}><span class="bet-word">▲ YES</span><span>Above</span><span class="bet-price">price <span id="fcYesP">${q ? q.yes : '–'}</span></span></button>
    <button class="btn-no" data-act="fcAsk" data-args='["no"]' id="fcNo" ${!q || locked || made || left <= 0 ? 'disabled' : ''}><span class="bet-word">▼ NO</span><span>Not above</span><span class="bet-price">price <span id="fcNoP">${q ? q.no : '–'}</span></span></button></div>
    <p class="odds-line" id="fcOdds"></p>
    ${locked ? `<p class="no">Calls are closed for this round. Next round starts at ${fmtClock(r.end, S.fast)}.</p>` : ''}
    <div id="fcConfirm"></div></div>`;
  h += `<div class="card"><h2>How rewards and the house spread work</h2><ul>
    <li>Each round has a start price. YES wins if Bitcoin ends <b>above</b> it. Otherwise (or an exact tie) NO wins. We use the real Bitcoin price from Coinbase (backup: Kraken). Results are never changed.</li>
    <li>The price is our estimate of the chance, from how far Bitcoin is from the line and how much time is left (Bitcoin's usual swing, about 50% a year, kept between 3% and 97%).</li>
    <li>A fair YES price plus a fair NO price is 100. Ours add up to <b>104</b>: the house spread is ${FEE_PER_SIDE} points per side.</li>
    <li>Your win reward = ${fmt(fcBase())} × 100 ÷ price, in each of grain, timber and ore, plus 1 Shard and a ${fmtDur(T(SHIELD_FORECAST))} shield. Lower price (less likely) = bigger reward. Because the price includes the spread, the reward is a little less than fair. House spread kept so far: <b>${fmt(S.fc.spreadKept)}</b> resources.</li>
    <li>A wrong call loses nothing. One call per round. Daily cap: ${fmt(fcCap())} of each resource.</li></ul></div>`;
  h += `<div class="card"><h2>Your calls</h2>${S.fc.calls.length ? S.fc.calls.slice(0, 12).map((c) => {
    const rr = S.fc.rounds[c.roundId] || {};
    return `<p><b>${fmtClock(rr.end || c.t, S.fast)}</b>: ${c.side.toUpperCase()} at ${c.price}, line ${fmtUSD(rr.strike)}${rr.close != null ? `, ended ${fmtUSD(rr.close)}` : ''}. ${c.status === 'open' ? 'Waiting…' : c.status === 'won' ? '<span class="ok">WON</span> ' + esc(c.note) : c.status === 'lost' ? '<span class="no">Missed.</span> ' + esc(c.note) : esc(c.note)}</p>`;
  }).join('') : '<p>No calls yet.</p>'}<p class="small"><a href="index.html">Back to home</a></p></div>`;
  return h;
}
function updateForecastLive() {
  if (activeTab !== 'forecast' || !$('fcPrice')) return;
  const r = fcRound(), q = fcQuote(r), sim = usingSim();
  const cur = sim ? feed.sim : feed.live;
  $('fcPrice').textContent = fmtUSD(cur);
  if ($('fcYesP')) { $('fcYesP').textContent = q ? q.yes : '–'; $('fcNoP').textContent = q ? q.no : '–'; }
  if (r.strike != null && cur != null) {
    const d = cur - r.strike;
    $('fcDiff').textContent = d > 0 ? `Bitcoin is ${fmtUSD(d)} ABOVE the line. YES is winning.` : d < 0 ? `Bitcoin is ${fmtUSD(-d)} BELOW the line. NO is winning.` : 'Bitcoin is exactly on the line.';
  }
  $('fcOdds').textContent = q ? `Chance of YES (our estimate): about ${q.fairYes}%. Fair: YES ${q.fairYes} + NO ${q.fairNo} = 100. Our prices: YES ${q.yes} + NO ${q.no} = 104. The extra 4 is the house spread.` : '';
  const box = $('fcConfirm');
  if (fcConfirm && q) {
    const price = fcConfirm === 'yes' ? q.yes : q.no, fair = fcConfirm === 'yes' ? q.fairYes : q.fairNo;
    const html = `<div class="confirm"><h3>Make a free ${fcConfirm.toUpperCase()} call at ${price}?</h3><ul>
      <li>${fcConfirm === 'yes' ? 'If Bitcoin ends ABOVE' : 'If Bitcoin ends AT or BELOW'} ${fmtUSD(r.strike)} at ${fmtClock(r.end, S.fast)}: you get <b>${fmt(fcReward(price))}</b> grain, timber and ore, +1 Shard, + shield.</li>
      <li>If not: you lose nothing.</li><li>At the fair price (${fair}) the reward would be ${fmt(fcReward(fair))}. The difference is the house spread.</li><li>Uses 1 of your free calls today.</li></ul>
      ${btn('Make the call', 'fcMake', [fcConfirm])} ${btn('Cancel', 'fcCancel', [], 'alt')}</div>`;
    if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
  } else if (box.innerHTML) { box.innerHTML = ''; box.dataset.sig = ''; }
}

function viewChat() {
  if (S.chat) S.chat.unread = 0;
  const ch = CHANNELS.find((c) => c.id === chatCh);
  const msgs = S.chat.msgs.filter((m) => m.ch === chatCh && !S.chat.muted.includes(m.author)).slice(-60);
  return `<div class="card"><h2>🦅 ${BANNER_NAME} · banner chat</h2><p class="small">Demo chat: it stays on this computer. Other members are AI bots. Real multiplayer chat needs a server (later, with Joney's okay).</p>
  <div class="chat-layout"><div>${CHANNELS.map((c) => `<button class="chan ${c.id === chatCh ? 'on' : ''}" data-act="chatCh" data-args='["${c.id}"]'>${c.name}</button>`).join('')}
    <h3>Members</h3>${MEMBERS.map((m) => `<div class="small"><b>${m.name}</b> <span class="role ${m.role}">${m.role}</span> <button class="btn alt" style="min-height:34px;padding:2px 8px;font-size:0.75rem" data-act="mute" data-args='["${m.name}"]'>${S.chat.muted.includes(m.name) ? 'Unmute' : 'Mute'}</button></div>`).join('')}
    <p class="small"><label><input type="checkbox" data-act="filter" ${S.chat.filter ? 'checked' : ''}> Word filter</label></p></div>
  <div><p class="small">${ch.about}</p><div class="msgs" id="msgs">${msgs.map((m) => `<div class="msg ${m.kind}"><span class="who">${esc(m.author)}</span>${roleOf(m.author) ? `<span class="role ${roleOf(m.author)}">${roleOf(m.author)}</span>` : ''}<span class="when">${fmtClock(m.t)}</span><div>${esc(filterText(m.text))}</div>
    <div class="reacts">${EMOJIS.map((e) => `<button class="${m.mine.includes(e) ? 'mine' : ''}" data-act="react" data-args='[${m.id},"${e}"]' aria-label="react ${e}">${e}${m.react[e] ? ' ' + m.react[e] : ''}</button>`).join('')}</div></div>`).join('') || '<p class="small">No messages yet.</p>'}</div>
  ${chatCh === 'battle-feed' ? '<p class="small">Only the game posts here. React away!</p>' : `<div class="chat-input"><input id="chatIn" type="text" maxlength="300" placeholder="Say something to ${ch.name}"><button class="btn" data-act="send">Send</button></div>`}</div></div></div>`;
}

function viewShop() {
  const gemBtn = (label, act, args, gems) => btn(`${label}<br><span class="small" style="color:inherit">${gems} Gems</span>`, act, args, 'alt', S.gems < gems);
  const shBtn = (label, args, gems) => btn(`${label}<br><span class="small" style="color:inherit">${gems} Gems${shieldAllowed() ? '' : ' · limit: 1 per ' + fmtDur(T(SHIELD_CAP_WINDOW))}</span>`, 'buyShield', args, 'alt', S.gems < gems || !shieldAllowed());
  return `<div class="card"><h2>Shop <span class="demo-label">DEMO · NO REAL PAYMENTS</span></h2>
    <p>Nothing here costs real money. Gems are earned by playing (daily gift, sea monsters, season pass, demo ads). Gems, Shards and items can never be cashed out or traded for prizes. Prices never change and there are no timed deals.</p>
    <p>You have <b>${fmt(S.gems)} Gems</b> and <b>${fmt(S.shards)} Shards</b>.</p></div>
  <div class="card"><h2>Gem packs</h2><p class="no">Buying is turned off in this demo. No payment system exists here.</p><div class="btn-row">
    ${['Pouch: 100 Gems', 'Chest: 550 Gems', 'Vault: 1,200 Gems', 'Starter pack', 'VIP (monthly)'].map((x) => `<button class="btn alt" disabled>${x}<br><span class="small">Not for sale in demo</span></button>`).join('')}</div>
    <p class="small">Free Gems: ${btn('Watch a demo ad (+1 Gem)', 'watchAd', [], 'alt')} (${S.daily.adsDay === today() ? 5 - S.daily.ads : 5} left today; no real ad is shown)</p></div>
  <div class="card"><h2>⏩ Time skips</h2><p class="small">Moves all your build and training timers forward.</p><div class="btn-row">
    ${gemBtn('Skip 15 minutes', 'buySkip', [15, 5], 5)} ${gemBtn('Skip 1 hour', 'buySkip', [60, 15], 15)}</div></div>
  <div class="card" id="shopShields"><h2>🛡 Shields</h2><div class="btn-row">${shBtn('Shield ' + fmtDur(T(2 * HOUR)), [2, 20], 20)} ${shBtn('Shield ' + fmtDur(T(8 * HOUR)), [8, 60], 60)}</div>
    ${shieldAllowed() ? `<p class="small">Max 1 shield per ${fmtDur(T(SHIELD_CAP_WINDOW))}, from any source. Buying one now uses it.</p>` : `<p class="no" id="shieldCapWhy">Shield buttons are off: ${shieldCapText()}</p>`}</div>
  <div class="card"><h2>🎯 Teleports</h2><div class="btn-row">${gemBtn('1 Teleport', 'buyTele', [15], 15)}</div><p class="small">Cooldown still applies.</p></div>
  <div class="card"><h2>🎨 Isle looks (cosmetic only)</h2><div class="btn-row">${Object.entries(THEMES).map(([k, t]) => S.cos.owned.includes(k)
      ? btn(`${t.name}<br><span class="small" style="color:inherit">${S.cos.theme === k ? 'In use (tap to remove)' : 'Owned (tap to use)'}</span>`, 'buyTheme', [k], 'alt')
      : btn(`${t.name}<br><span class="small" style="color:inherit">${t.shards} Shards</span>`, 'buyTheme', [k, 'shards'], 'alt', S.shards < t.shards) + btn(`${t.name}<br><span class="small" style="color:inherit">${t.gems} Gems</span>`, 'buyTheme', [k, 'gems'], 'alt', S.gems < t.gems)).join('')}</div></div>
  <div class="card"><h2>📜 Season pass</h2><p>Season XP: <b>${fmt(S.pass.xp)}</b> (tier every ${PASS_XP} XP). Earn XP by building, fighting, forecasting and daily gifts.</p>
    <p>Premium track: ${S.pass.premium ? '<span class="ok">ON (demo)</span>' : btn('Turn on premium track (demo, free)', 'passPremium', [], 'alt')} <span class="small">In a real game this would be a paid item. Here it is a free switch so you can see it. Premium rewards are looks and time skips, not raw power.</span></p>
    <table><tr><th>Tier</th><th>Free</th><th>Premium</th></tr>${PASS_TIERS.map((t, i) => {
      const ok = S.pass.xp >= (i + 1) * PASS_XP;
      const cell = (track, rw) => S.pass.claimed.includes(track + i) ? `✔ ${rewardText(rw)}` : ok && (track === 'f' || S.pass.premium) ? btn('Claim ' + rewardText(rw), 'claimPass', [i, track], 'alt') : `<span class="small">${rewardText(rw)}</span>`;
      return `<tr><td>${i + 1}</td><td>${cell('f', t.free)}</td><td>${cell('p', t.prem)}</td></tr>`;
    }).join('')}</table></div>`;
}

function viewHelp() {
  return `<div class="card laurel"><h2>Help and settings</h2>
  <h3>How to play</h3><ol><li>Upgrade buildings, then the Spire. Each Spire level needs every building at the Spire's level, shown on the Isle screen.</li>
  <li>Pick a perk each time the Spire levels up.</li><li>Train troops and fight sea monsters for loot.</li>
  <li>Keep a shield up, or rivals can raid you. A big enough raid wipes you. If that happens you get a Comeback Tailwind.</li>
  <li>Hunt rivals: teleport next to them and siege them when their shield is down.</li><li>Make free Bitcoin Forecast calls for bonus resources.</li></ol>
  <h3>Builders and the build queue</h3><p>You have ${BUILDERS} builders. When both are busy you can line up ONE more upgrade. It starts by itself when a builder is free (even while you are away), but only if you can pay for it at that moment; otherwise it waits and the Builders card says why. You pay when it starts, not when you line it up, and you can cancel it for free.</p>
  <p>Finish now costs 1 Gem per ${FINISH_MIN_PER_GEM} minutes left for the first hour, then 1 Gem per ${FINISH_MIN_PER_GEM_LONG} minutes beyond an hour.</p>
  <h3>Shields and raids</h3><p>${SHIELD_RULE()}</p>
  <p><b>Raid warning:</b> from Spire level ${TIP_MIN_SPIRE}, the Isle screen warns you when the strongest rival at your Spire level would wipe you (its attack is double your defense or more): "${TROOP_TIP}"</p>
  <h3>Speed</h3><p>${S.fast ? '<b>Fast demo mode is ON.</b> Timers are 60x shorter, raids come every ' + fmtDur(T(RAID_EVERY)) + ', production is 20x, forecast rounds are 1 minute.' : 'Normal speed. Longest timer is 20 hours. Raids every 2 hours. Forecast rounds are 15 minutes.'}</p>
  ${btn(S.fast ? 'Switch to normal speed' : 'Switch to fast demo mode', 'toggleFast', [], 'alt')}
  <h3>Progress while away</h3><p>Resources keep coming for up to 12 hours while you are away. Builds, training, healing and raids keep happening too.</p>
  <h3>Catch-up boosts</h3><p>New-player Tailwind: 2x until Spire level 4. Comeback Tailwind after a wipe: ${COMEBACK_MULT}x for ${fmtDur(T(COMEBACK_TIME))}.</p>
  <h3>Name</h3><input id="nameSet" type="text" maxlength="20" value="${esc(S.name)}"> ${btn('Save name', 'saveName', [], 'alt')}
  <h3>Start over</h3>${btn('Erase this game and start over', 'resetGame', [], 'bad')}
  <p class="small">Play points only. Nothing in this game can be bought with real money, cashed out, or traded for prizes.</p></div>`;
}

let lastSig = '';
function render() {
  renderTop();
  if (!S.faction) { $('view').innerHTML = viewFaction(); return; }
  if (activeTab === 'battle' && !battle) activeTab = 'army';
  const v = { market: viewMarket, isle: viewIsle, army: viewArmy, battle: viewBattle, forecast: viewForecast, chat: viewChat, shop: viewShop, help: viewHelp }[activeTab];
  const keepInput = $('chatIn') ? $('chatIn').value : '';
  const scrollMsgs = activeTab === 'chat';
  $('view').innerHTML = v();
  if ($('chatIn')) $('chatIn').value = keepInput;
  if (scrollMsgs && $('msgs')) $('msgs').scrollTop = $('msgs').scrollHeight;
  updateForecastLive();
  lastSig = sig();
}
// A cheap fingerprint of things that should redraw the screen when they change.
function sig() {
  if (activeTab === 'battle' || activeTab === 'chat') return activeTab; // redraw these only on real changes
  const r = activeTab === 'forecast' ? fcRound() : null;
  return [activeTab, BKEYS.map((k) => upgradeInfo(k).block).join('|'), upgradeInfo('spire').block, S.train ? 1 : 0,
    [10, 50, 100].map((n) => canAfford(trainCost(trainSel.tier, n))).join(), shieldUp(),
    r ? [r.id, r.strike, !!fcQuote(r), Date.now() >= r.end - fcLock()].join() : '',
    activeTab === 'army' ? RIVALS.map((x) => rivalShield(x).up).join() + Object.values(S.monsters).map((t) => t > Date.now()).join() + (S.tele.alertUntil > Date.now()) + (S.tele.cooldownUntil > Date.now()) : '',
    S.queue.length, S.b.spire, S.nextUp ? S.nextUp.key + S.nextUp.to + (nextUpStatus().poor ? 'poor' : nextUpStatus().why) : '', shieldAllowed(), showTroopTip()].join('#');
}
function updateCountdowns() {
  const now = Date.now();
  document.querySelectorAll('[data-until]').forEach((el) => { el.textContent = fmtDur(+el.dataset.until - now); });
  const nw = $('nextUpWhy'), ns = S.nextUp && nextUpStatus(now); if (nw && ns && ns.why) nw.textContent = ns.why;
  document.querySelectorAll('[data-gems]').forEach((el) => { el.textContent = finishNowCost({ end: +el.dataset.gems }, now); });
}

// ======================= Actions (one click handler) =======================
const ACTIONS = {
  pickFaction: (k) => { const n = $('nameIn').value.trim(); if (n) S.name = n.slice(0, 20); S.faction = k; chatInit(); postChat('general', 'Rook', `${S.name} of the ${FACTIONS[k].name} has joined us. Welcome!`); save(); changed(); render(); },
  startUpgrade, queueNext, cancelNext, finishNow, choosePerk, claimGift, healNow, teleport,
  dismissAway: () => { awaySummary = null; changed(); render(); },
  selTrain: (type, tier) => { trainSel = { type, tier: S.b.barracks >= TIER_UNLOCK[tier] ? tier : 0 }; render(); },
  startTrain,
  gridMonster: (lvl) => startGrid(fightCtx('monster', { lvl })),
  autoMonster: (lvl) => { const c = fightCtx('monster', { lvl }); const w = canStartFight(c); if (w) return toast(w, 'bad'); autoResolve(c); },
  gridHunt: (id) => startGrid(fightCtx('hunt', { rival: id })),
  autoHunt: (id) => { const c = fightCtx('hunt', { rival: id }); const w = canStartFight(c); if (w) return toast(w, 'bad'); autoResolve(c); },
  gridCounter: (eid) => { const e = S.revenge.find((x) => x.id === eid); startGrid(fightCtx('counter', { rival: e.rival, revengeId: eid })); },
  autoCounter: (eid) => { const e = S.revenge.find((x) => x.id === eid); const c = fightCtx('counter', { rival: e.rival, revengeId: eid }); const w = canStartFight(c); if (w) return toast(w, 'bad'); autoResolve(c); },
  revengeTele: (rid, eid) => teleport(rid, eid),
  gridClick, endTurn, retreat,
  autoBattle: () => { if (battle) { const c = battle.ctx; battle = null; autoResolve(c); } },
  fcAsk: (side) => { fcConfirm = side; updateForecastLive(); },
  fcMake, fcCancel: () => { fcConfirm = null; updateForecastLive(); },
  chatCh: (c) => { chatCh = c; render(); },
  send: () => sendChat($('chatIn').value),
  react: toggleReact,
  mute: (n) => { S.chat.muted = S.chat.muted.includes(n) ? S.chat.muted.filter((x) => x !== n) : [...S.chat.muted, n]; save(); render(); },
  filter: () => { S.chat.filter = !S.chat.filter; save(); render(); },
  trade, sellItem, watchAd, buySkip, buyShield, buyTheme, claimPass,
  buyTele: (g) => { if (S.gems < g) return toast('Not enough Gems.', 'bad'); S.gems -= g; S.tele.tokens++; toast('+1 Teleport.', 'good'); save(); render(); },
  passPremium: () => { S.pass.premium = true; toast('Premium track turned on (demo, no payment).', 'good'); save(); render(); },
  toggleFast: () => { S.fast = !S.fast; S.raid.next = Date.now() + T(RAID_EVERY); fcConfirm = null; toast(S.fast ? 'Fast demo mode on.' : 'Normal speed on.'); save(); changed(); render(); },
  saveName: () => { const n = $('nameSet').value.trim(); if (n) { S.name = n.slice(0, 20); save(); toast('Name saved.', 'good'); render(); } },
  resetGame: () => { if (confirm('Erase everything and start over? This cannot be undone.')) { localStorage.removeItem(KEY); location.reload(); } },
};
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act]');
  if (t && !t.disabled) {
    if (t.type === 'checkbox') { ACTIONS[t.dataset.act](); return; }
    let args = []; try { args = JSON.parse(t.dataset.args || '[]'); } catch (e) { /* none */ }
    ACTIONS[t.dataset.act](...args);
    return;
  }
  const tab = ev.target.closest('[data-tab]');
  if (tab) { activeTab = tab.dataset.tab; if (activeTab === 'army' && battle) activeTab = 'battle'; $('toast').hidden = true; render(); window.scrollTo(0, 0); }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'chatIn') ACTIONS.send(); });

// ======================= Start =======================
function tick() {
  const before = version;
  stepSim();
  advance(Date.now());
  fcDayReset();
  const r = fcRound(); fcOpenStrike(r); fcSettleDue();
  aiChatter(); mktStep();
  if (eventLog.length) { const ev = eventLog.splice(0); if (!awaySummary) ev.forEach((e) => toast(e.text, e.kind)); else awaySummary.events.push(...ev); changed(); }
  if (version !== before || sig() !== lastSig) render();
  else { renderTop(); updateCountdowns(); updateForecastLive(); }
  save();
}
(function start() {
  const gap = Date.now() - S.last;
  const before = { ...S.res };
  advance(Date.now());
  if (gap > 60e3 && S.faction) {
    awaySummary = { ms: gap, gain: {}, events: eventLog.splice(0) };
    RES.forEach((r) => { awaySummary.gain[r] = Math.max(0, S.res[r] - before[r]); });
    if (gap > DAY) S.boost = { until: Date.now() + T(30 * MIN), mult: 2, why: 'Welcome-back Tailwind' };
  } else eventLog.length = 0;
  if (S.faction) chatInit();
  mktInit(); dropsInit();
  applyTheme(); save(); render();
  poll(); setInterval(poll, 2000); setInterval(tick, 1000);
  /* test hooks removed for public build */
})();
})();
