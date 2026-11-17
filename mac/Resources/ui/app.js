// AI Watchdog 화면. Swift(App.swift)가 AW.init / AW.tick / AW.procList 를 부르고,
// 이 파일은 native({cmd:...}) 로 Swift에 요청한다.
(() => {
'use strict';
const L = window.AWLogic, I = window.AWI18n, M = window.AWMeters;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const clock = () => Date.now() / 1000;

const PRESETS = [
  { id: 'claude', label: 'Claude', names: 'claude', mode: 'cpu', logs: 'claude' },   // logs: AI 대화 기록으로 판정
  { id: 'chatgpt', label: 'ChatGPT', names: 'chatgpt', mode: 'cpu' },
  { id: 'codex', label: 'Codex', names: 'codex', mode: 'cpu', logs: 'codex' },
  { id: 'cursor', label: 'Cursor', names: 'cursor', mode: 'cpu' },
  { id: 'antigravity', label: 'Antigravity', names: 'antigravity', mode: 'cpu' },
  { id: 'ollama', label: 'Ollama', names: 'ollama', mode: 'cpu' },
  { id: 'lmstudio', label: 'LM Studio', names: 'lm studio', mode: 'cpu' },
  { id: 'python', label: 'Python', names: 'python3, python', mode: 'alive' },
];
const DEFAULTS = { version: 1, lang: null, theme: 'system', cpuTh: 5, graceSec: 120, idleMin: 10, action: 2,
  auto: false, awake: true, display: false, userIdle: true, notify: true, meters: true, startup: false };
// 팬: mode = 화면에서 고르는 중인 것, live = 적용된 것 (적용을 눌러야 바뀜)
const FAN_CURVE = [{ t: 45, p: 0 }, { t: 65, p: 20 }, { t: 80, p: 55 }, { t: 92, p: 100 }];
const FAN_DEFAULTS = { mode: 'auto', sync: true, pct: [35, 35], curve: FAN_CURVE, live: { mode: 'auto' } };
const TABS = ['main', 'sys', 'fan', 'tok'];
const ICON = { 1: 'screen', 2: 'moon', 3: 'power' };
const KIND_N = { screen: 1, sleep: 2, shutdown: 3 };

let langs = {}, T = k => k, S = null, st = null, view = 'main', lang = 'en', culture = 'en-US';
let todayKey = '', todaySec = 0, lastErr = '', errAt = 0, lastHold = null, lastStatus = '', procAll = [], pickSel = null;
let saveTimer = 0, gpuOk = true;
let tab = 'main', hw = { fans: [], temps: {}, helper: 'missing', sys: null }, cpuHist = [], gpuHist = [], netPrev = null, netRate = { rx: 0, tx: 0 };
let fanSent = null, fanMsg = '', fanMsgAt = 0, fanMsgErr = false, tokRows = null, tokAt = 0, tokBusy = false, heatSel = null;

// 화면 스크립트 오류는 macOS 로그로 보냄 (log show --predicate 'process == "AIWatchdog"')
window.addEventListener('error', e => native({ cmd: 'jsError', msg: `${e.message} @${e.lineno}:${e.colno}` }));
const native = msg => {
  try { window.webkit.messageHandlers.aw.postMessage(msg); }
  catch { if (window.AW_MOCK) { console.debug('native', msg); if (window.AW_MOCK_REPLY) window.AW_MOCK_REPLY(msg); } }
};

// ---------------------------------------------------------------- 서식
const F = (key, ...a) => I.fmt(T(key), ...a);
function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}
function fmtSpan(sec) {
  sec = Math.floor(sec);
  if (sec < 60) return F('unit.sec', sec);
  const m = Math.floor(sec / 60), r = sec % 60;
  return r === 0 ? F('unit.min', m) : F('unit.minsec', m, r);
}
function fmtDur(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return F('unit.sec', s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h > 0 ? F('unit.hourmin', h, m) : F('unit.min', m);
}
function fmtRate(b) {
  if (b >= 1048576) return I.fmt('{0:0.#} MB/s', b / 1048576);
  if (b >= 1024) return I.fmt('{0:0} KB/s', b / 1024);
  return '0 KB/s';
}
const actWord = n => T('act.word.' + n), actPhrase = n => T('act.phrase.' + n);
function subject(name) {               // 한국어: 받침이면 '이', 아니면 '가'
  if (lang !== 'ko' || !name) return name;
  const c = name.charCodeAt(name.length - 1);
  return name + (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 !== 0 ? '이' : '가');
}
const dateKey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const presetLabel = id => id === 'python' ? T('preset.python') : (PRESETS.find(p => p.id === id) || {}).label || id;

// ---------------------------------------------------------------- 설정
function buildSettings(saved) {
  const s = Object.assign({}, DEFAULTS, saved || {});
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || lo));
  s.cpuTh = clamp(s.cpuTh, 0.5, 50); s.graceSec = clamp(s.graceSec, 30, 1800); s.idleMin = clamp(s.idleMin, 1, 240);
  if (![1, 2, 3].includes(s.action)) s.action = 2;
  const f = Object.assign({}, FAN_DEFAULTS, s.fan || {});
  if (!['auto', 'fixed', 'curve'].includes(f.mode)) f.mode = 'auto';
  f.pct = [0, 1].map(i => clamp((f.pct || [])[i] ?? 35, 0, 100));
  if (!Array.isArray(f.curve) || f.curve.length !== 4) f.curve = FAN_CURVE.map(x => ({ ...x }));
  f.curve = f.curve.map(x => ({ t: clamp(x.t, 30, 100), p: clamp(x.p, 0, 100) }));
  if (!f.live || !['auto', 'fixed', 'curve'].includes(f.live.mode)) f.live = { mode: 'auto' };
  s.fan = f;
  const fresh = !saved || !Array.isArray(saved.targets);
  const old = new Map((saved && saved.targets || []).map(t => [t.id, t]));
  s.targets = PRESETS.map(p => {
    const o = old.get(p.id);
    return { id: p.id, label: p.label, names: p.names, preset: true, logs: p.logs,
      mode: o ? (o.mode === 'alive' ? 'alive' : 'cpu') : p.mode,
      enabled: o ? !!o.enabled : fresh && p.id === 'claude' };
  });
  for (const o of (saved && saved.targets) || []) {
    if (!o.preset && o.id && o.names) s.targets.push({ id: o.id, label: o.label || o.names, names: o.names,
      mode: o.mode === 'alive' ? 'alive' : 'cpu', enabled: !!o.enabled, preset: false });
  }
  return s;
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => native({ cmd: 'save', settings: S }), 400);
}
function changed() { save(); sync(); render(); }

// ---------------------------------------------------------------- 언어·테마
function applyLang(code) {
  if (!langs[code]) code = 'en';
  lang = code; S.lang = code;
  T = I.makeT(langs[code], langs.en);
  culture = langs[code].culture || 'en-US';
  document.documentElement.lang = code;
  $$('[data-t]').forEach(e => { e.textContent = T(e.dataset.t); });
  $$('[data-tip]').forEach(e => { e.title = T(e.dataset.tip); });
  $('#langTitle').textContent = code === 'en' ? 'Language' : T('lang.label') + ' (Language)';
  const sel = $('#langSel');
  sel.innerHTML = '';
  Object.values(langs).sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.code.localeCompare(b.code)).forEach(d => {
    const o = document.createElement('option');
    o.value = d.code; o.textContent = `${d.name} (${d.code})`; o.selected = d.code === code;
    sel.appendChild(o);
  });
  S.targets.forEach(t => { if (t.preset) t.label = presetLabel(t.id); });
  native({ cmd: 'menu', open: T('tray.open'), wake1h: T('tray.wake1h'), wakeoff: T('x.wakeoff'), quit: T('tray.exit') });
  buildAgents(); buildTargets(); showView(view); sync(); render();
}
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const eff = S.theme === 'system' ? (darkMQ.matches ? 'dark' : 'light') : S.theme;
  document.documentElement.dataset.theme = eff;
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === S.theme));
}
darkMQ.addEventListener('change', () => S && applyTheme());

// ---------------------------------------------------------------- 화면 전환
function showView(v) {
  view = v;
  if (TABS.includes(v)) tab = v;
  const sub = !TABS.includes(v);
  $('#vMain').hidden = v !== 'main'; $('#vTargets').hidden = v !== 'targets'; $('#vSettings').hidden = v !== 'settings';
  $('#vSys').hidden = v !== 'sys'; $('#vFan').hidden = v !== 'fan'; $('#vTok').hidden = v !== 'tok';
  $('#tabs').hidden = sub;
  $$('#tabs button').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.tab === v)); b.tabIndex = b.dataset.tab === v ? 0 : -1; });
  $('#title').textContent = v === 'targets' ? T('title.targets') : v === 'settings' ? T('x.tip.settings') : 'AI Watchdog';
  const b = $('#btnSettings');
  b.innerHTML = `<svg><use href="#i-${sub ? 'back' : 'gear'}"/></svg>`;
  b.title = sub ? T('tip.back') : T('x.tip.settings');
  if (v === 'tok') askTokens(false);
  if (v === 'fan') buildFanCtl();
  if (v !== 'targets') $('#picker').hidden = true;
  $('#powerPop').hidden = true;
}

// ---------------------------------------------------------------- 감시 목록
function buildAgents() {
  const box = $('#agents'); box.innerHTML = '';
  const on = S.targets.filter(t => t.enabled);
  if (!on.length) { box.innerHTML = `<div class="empty"></div>`; box.firstChild.textContent = T('agent.empty'); return; }
  for (const t of on) {
    const row = document.createElement('div');
    row.className = 'agent'; row.dataset.id = t.id;
    row.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="st"></span>';
    row.querySelector('.nm').textContent = t.label;
    row.querySelector('.st').textContent = T('agent.checking');
    box.appendChild(row);
  }
}
function updateAgents() {
  for (const row of $$('#agents .agent')) {
    const ts = st.t[row.dataset.id]; if (!ts) continue;
    const stEl = row.querySelector('.st');
    stEl.textContent = { off: T('hero.off'), cmd: T('agent.cmd'), running: T('agent.running'),
      ai: ts.aiCount > 1 ? F('agent.aiN', ts.aiCount) : T('agent.ai'),
      working: F('agent.working', ts.pct), idle: T('hero.idle'), checking: T('agent.checking') }[ts.status];
    row.classList.toggle('lit', ['cmd', 'running', 'working', 'ai'].includes(ts.status));
    row.classList.toggle('idle', ts.status === 'idle');
    row.title = ts.running ? F('agent.mem', ts.mem / 1073741824) : '';
  }
}
function buildTargets() {
  const box = $('#targets'); box.innerHTML = '';
  for (const t of S.targets) {
    const row = document.createElement('div');
    row.className = 'target';
    row.innerHTML = `<div class="info"><b></b><small></small></div><button class="ghost mode"></button>` +
      (t.preset ? '' : `<button class="ic del" title=""><svg><use href="#i-trash"/></svg></button>`) +
      `<label class="switch"><input type="checkbox"><i></i></label>`;
    row.querySelector('b').textContent = t.label;
    row.querySelector('small').textContent = L.splitNames(t.names).join(', ');
    const mb = row.querySelector('.mode');
    mb.textContent = T(t.mode === 'alive' ? 'mode.alive' : 'mode.cpu'); mb.title = T('mode.tip');
    mb.onclick = () => { t.mode = t.mode === 'alive' ? 'cpu' : 'alive'; mb.textContent = T(t.mode === 'alive' ? 'mode.alive' : 'mode.cpu'); changed(); };
    const del = row.querySelector('.del');
    if (del) { del.title = T('target.remove'); del.onclick = () => { S.targets = S.targets.filter(x => x !== t); delete st.t[t.id]; buildTargets(); buildAgents(); changed(); if (!$('#picker').hidden) fillProcs(); }; }
    const sw = row.querySelector('input');
    sw.checked = t.enabled; sw.setAttribute('aria-label', F('target.watchName', t.label));
    sw.onchange = () => { t.enabled = sw.checked; if (st.t[t.id]) st.t[t.id].first = true; buildAgents(); changed(); };
    box.appendChild(row);
  }
}
function fillProcs() {
  const known = new Set(S.targets.flatMap(t => L.splitNames(t.names)));
  const q = $('#search').value.trim().toLowerCase();
  const box = $('#procs'); box.innerHTML = ''; pickSel = null;
  for (const p of procAll) {
    if (known.has(p.name.toLowerCase())) continue;
    const disp = p.label && p.label.toLowerCase() !== p.name.toLowerCase() ? `${p.label}  (${p.name})` : p.name;
    if (q && !disp.toLowerCase().includes(q)) continue;
    const d = document.createElement('div');
    d.textContent = disp;
    d.onclick = () => { $$('#procs .sel').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); pickSel = p; };
    d.ondblclick = () => { pickSel = p; addPicked(); };
    box.appendChild(d);
  }
}
function addPicked() {
  if (!pickSel) { $('#pickHint').textContent = T('pick.first'); return; }
  const p = pickSel;
  S.targets.push({ id: 'c' + Date.now(), label: p.label || p.name, names: p.name.toLowerCase(), mode: 'cpu', enabled: true, preset: false });
  buildTargets(); buildAgents(); fillProcs(); changed();
  $('#pickHint').textContent = F('pick.added', p.label || p.name);
}

// ---------------------------------------------------------------- 컨트롤 값
const STEP = {
  idleMin: (v, d) => Math.min(240, Math.max(1, v + d * (d < 0 ? (v > 10 ? 5 : 1) : (v >= 10 ? 5 : 1)))),
  cpuTh: (v, d) => Math.min(50, Math.max(0.5, v + d * 0.5)),
  graceSec: (v, d) => Math.min(1800, Math.max(30, v + d * 30)),
};
function sync() {
  $$('input[data-k]').forEach(i => { i.checked = !!S[i.dataset.k]; });
  $('#idleVal').textContent = F('unit.min', S.idleMin);
  $('#cpuVal').textContent = I.fmt('{0:0.#}%', S.cpuTh);
  $('#graceVal').textContent = fmtSpan(S.graceSec);
  $$('.tile').forEach(b => b.classList.toggle('on', +b.dataset.action === S.action));
  $('#flowIcon').innerHTML = `<use href="#i-${ICON[S.action]}"/>`;
  $('#flowText').textContent = actWord(S.action);
  $('#autoPanel').classList.toggle('dim', !S.auto);
  $('#swDisplay').classList.toggle('dim', !S.awake);
  $('#meters').hidden = !S.meters;
  $('#pmWakeOff').disabled = !(st && clock() < st.forceUntil);
}

// ---------------------------------------------------------------- 그리기
function ring(frac, color) {
  const c = 2 * Math.PI * 82, arc = $('#arc');
  arc.style.stroke = `var(--${color})`;
  arc.style.strokeDasharray = `${Math.max(0, Math.min(1, frac)) * c} 600`;
}
function hero(big, size, small, title, desc) {
  const b = $('#big'); b.textContent = big; b.style.fontSize = size + 'px';
  $('#small').textContent = small; $('#small').hidden = !small;
  $('#stTitle').textContent = title; $('#stDesc').textContent = desc;
}
function meter(id, val, text, extra) {
  const m = $(id);
  m.querySelector('b').textContent = val == null ? '-' : (text ?? I.fmt('{0:0}%', val));
  m.querySelector('s').style.width = (val == null ? 0 : Math.max(0, Math.min(100, val))) + '%';
  m.classList.toggle('hot', val != null && val >= 90 && !extra);
}
function todayTotal(now) {
  const key = dateKey(new Date());
  if (key !== todayKey) { todayKey = key; todaySec = 0; }
  return todaySec + (st.wasWorking ? Math.max(0, now - st.workStart) : 0);
}

function render() {
  if (!st) return;
  const now = clock(), v = L.view(st, now);
  let state = 'Off', glow = false;
  $('#btnCancel').hidden = true; $('#btnEndWake').hidden = true;
  switch (v.mode) {
    case 'pending': {
      state = 'Rose';
      const n = KIND_N[st.pending.kind], r = Math.max(0, Math.ceil(st.pending.until - now));
      ring(r / st.pending.total, 'rose');
      hero(String(r), 52, F('hero.pendingSmall', actWord(n)), T('hero.pending.' + n), T('hero.pendingDesc'));
      $('#btnCancel').hidden = false; break;
    }
    case 'force': {
      state = 'Lamp'; glow = true;
      const left = st.forceUntil - now;
      ring(left / st.forceTotal, 'lamp');
      const at = new Date(st.forceUntil * 1000).toLocaleTimeString(culture, { hour: 'numeric', minute: '2-digit' });
      hero(fmtClock(left), 44, T('hero.left'), T('hero.force'), F('hero.forceDesc', at));
      $('#btnEndWake').hidden = false; break;
    }
    case 'working': {
      state = 'Lamp'; glow = !!lastHold;
      ring(1, 'lamp');
      const who = st.activeLabels.length ? st.activeLabels.join(', ') : 'AI';
      hero(fmtClock(now - st.workStart), 44, T('hero.worked'), T('hero.working'),
        lastHold ? F('hero.workingDesc', subject(who)) : T('hero.noHold'));
      break;
    }
    case 'countdown':
      state = 'Moon';
      ring(st.autoRemain / st.autoLimit, 'moon');
      hero(fmtClock(st.autoRemain), 44, F('hero.until', actWord(S.action)), T('hero.done'),
        st.userBusy ? T('hero.waitUser') : F('hero.leave', actPhrase(S.action)));
      break;
    case 'none': ring(0, 'off'); hero(T('hero.none'), 30, '', T('hero.noTargets'), T('hero.noTargetsDesc')); break;
    case 'off': ring(0, 'off'); hero(T('hero.off'), 30, '', T('hero.offTitle'), T('hero.offDesc')); break;
    default:
      state = 'Moon'; ring(0, 'moon');
      hero(T('hero.idle'), 30, '', T('hero.resting'), S.auto ? T('rest.auto.' + S.action) : T('rest.windows'));
  }
  $('#glow').classList.toggle('on', glow);

  // 사용량
  if (S.meters) {
    meter('#mCpu', st.cpuPct);
    meter('#mRam', st.memTotal ? 100 * st.memUsed / st.memTotal : null);
    $('#mRam').title = st.memTotal ? F('tip.ram', st.memUsed / 1073741824, st.memTotal / 1073741824) : '';
    meter('#mGpu', gpuOk ? st.gpuPct : null);
    $('#mGpu').title = gpuOk ? (st.gpuName || '') : T('tip.noGpu');
    const m = $('#mNet');
    m.querySelector('b').textContent = fmtRate(st.netRate);
    m.querySelector('s').style.width = Math.min(100, st.netRate / 13107200 * 100) + '%';
    m.title = T('tip.netQuiet');
  }
  updateAgents();
  if (view === 'sys') renderSys();
  else if (view === 'fan') renderFan();
  else if (view === 'tok') renderTokWhen();
  else if (view === 'settings') $('#setFan').hidden = !['ready', 'outdated'].includes(hw.helper);

  // 아래 안내
  const foot = $('#footer');
  if (lastErr && now - errAt < 10) { foot.className = 'err'; foot.textContent = lastErr; }
  else {
    lastErr = ''; foot.className = '';
    if (view === 'sys' || view === 'fan' || view === 'tok') foot.textContent = '';
    else if (view !== 'main') foot.textContent = T('foot.saved');
    else {
      let f = v.idle > 86400 ? T('foot.never') : F('foot.last', fmtSpan(v.idle));
      const today = todayTotal(now);
      if (today >= 60) f += '\n' + F('foot.today', fmtDur(today));
      foot.textContent = f;
    }
  }

  const tip = ('AI Watchdog: ' + $('#stTitle').textContent);
  if (state + tip !== lastStatus) { lastStatus = state + tip; native({ cmd: 'status', state, tip }); }
  $('#pmWakeOff').disabled = !(now < st.forceUntil);
}

// ---------------------------------------------------------------- 1초마다
function tick(sample) {
  if (!st) return;
  const now = clock();
  if (sample.wake) { L.resetBaseline(st); lastHold = null; }   // 깨어나면 깨워 두기를 다시 요청
  if (sample.gpuPct !== 'skip') {                                 // 'skip' = 창이 숨어 있어 사용량을 안 잼
    if (sample.gpuPct == null) gpuOk = false; else { gpuOk = true; st.gpuPct = sample.gpuPct; st.gpuName = sample.gpuName; }
  }
  L.ingest(st, sample, now);
  ingestHw(sample, now);
  fanDrive();
  advance(now);
}
function advance(now) {
  const r = L.step(st, now);
  if (r.hold !== lastHold || (r.hold && S.display !== st._disp)) {
    lastHold = r.hold; st._disp = S.display;
    native({ cmd: 'hold', on: r.hold, display: !!S.display });
  }
  if (r.alert) { showView('main'); render(); native({ cmd: 'show', alert: true }); }
  if (r.fire) native({ cmd: 'act', kind: r.fire });
  if (r.finished) finished(r.finished);
  render();
}
function finished(f) {
  native({ cmd: 'log', start: f.start, end: f.end, sec: Math.round(f.sec), programs: f.programs });
  if (dateKey(new Date(f.start * 1000)) === todayKey) todaySec += f.sec;
  if (!S.notify) return;
  const head = f.programs ? F('notice.done', subject(f.programs)) : T('hero.done');
  let body = F('notice.worked', fmtDur(f.sec));
  if (S.auto) body += ' ' + F('notice.auto', S.idleMin, actPhrase(S.action));
  native({ cmd: 'notify', title: head, body });
}

// ---------------------------------------------------------------- 이벤트
function wire() {
  $('#btnClose').onclick = () => native({ cmd: 'hide' });
  $('#btnSettings').onclick = () => { showView(TABS.includes(view) ? 'settings' : tab); render(); };
  $$('#tabs button').forEach(b => b.onclick = () => { showView(b.dataset.tab); render(); });
  $('#tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = (TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : 3)) % 4;
    showView(TABS[i]); render(); $(`#tabs [data-tab=${TABS[i]}]`).focus();
  });
  wireFan(); wireTok();
  $('#btnManage').onclick = () => { showView('targets'); render(); };
  $('#btnPower').onclick = e => { e.stopPropagation(); $('#powerPop').hidden = !$('#powerPop').hidden; sync(); };
  document.addEventListener('click', e => { if (!e.target.closest('#powerPop')) $('#powerPop').hidden = true; });
  $$('#powerPop [data-act]').forEach(b => b.onclick = () => {
    $('#powerPop').hidden = true;
    const k = b.dataset.act;
    if (k === 'screen') native({ cmd: 'act', kind: 'screen' });
    else { L.startPending(st, k, k === 'sleep' ? 5 : 10, clock()); render(); }
  });
  $$('#powerPop [data-wake]').forEach(b => b.onclick = () => { $('#powerPop').hidden = true; setForce(+b.dataset.wake); });
  $('#btnEndWake').onclick = () => setForce(0);
  $('#btnCancel').onclick = cancel;
  $$('.tile').forEach(b => b.onclick = () => { S.action = +b.dataset.action; changed(); });
  $$('[data-step]').forEach(b => b.onclick = () => { const k = b.dataset.step; S[k] = STEP[k](S[k], +b.dataset.dir); changed(); });
  $$('input[data-k]').forEach(i => i.onchange = () => {
    S[i.dataset.k] = i.checked;
    if (i.dataset.k === 'startup') native({ cmd: 'startup', on: i.checked });
    changed();
  });
  $$('#themeSeg button').forEach(b => b.onclick = () => { S.theme = b.dataset.theme; applyTheme(); changed(); });
  $('#langSel').onchange = e => { applyLang(e.target.value); save(); };
  $('#btnPick').onclick = () => {
    const p = $('#picker');
    p.hidden = !p.hidden;
    if (!p.hidden) { $('#search').value = ''; $('#pickHint').textContent = T('x.pickHint'); native({ cmd: 'procs' }); $('#search').focus(); }
  };
  $('#search').oninput = fillProcs;
  $('#btnAdd').onclick = addPicked;
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#powerPop').hidden) $('#powerPop').hidden = true;
    else if (st.pending) cancel();
    else if (!TABS.includes(view)) { showView(tab); render(); }
  });
  new ResizeObserver(() => native({ cmd: 'size', h: Math.ceil($('#card').getBoundingClientRect().height) })).observe($('#card'));
}
function setForce(min) { const now = clock(); L.setForce(st, min, now); sync(); advance(now); }
function cancel() { L.cancelPending(st); native({ cmd: 'show', alert: false }); render(); }

// ---------------------------------------------------------------- 하드웨어 값 (매초)
const fmtBytes = b => b >= 1e9 ? I.fmt('{0:0.#} GB', b / 1e9) : I.fmt('{0:0} MB', Math.max(0, b) / 1e6);
const money = c => '$' + c.toLocaleString('en-US', { minimumFractionDigits: c < 100 ? 2 : 0, maximumFractionDigits: c < 100 ? 2 : 0 });
const degree = c => I.fmt('{0:0}°C', c);
const HIST = 60;

function ingestHw(sample, now) {
  if (Array.isArray(sample.fans)) hw.fans = sample.fans;
  if (sample.temps) hw.temps = sample.temps;
  if (sample.fanHelper && sample.fanHelper !== hw.helper) { hw.helper = sample.fanHelper; fanSent = null; if (view === 'fan') buildFanCtl(); }
  if (!sample.sys) return;
  hw.sys = sample.sys;
  const x = sample.sys;
  if (netPrev && now > netPrev.t) {
    const dt = now - netPrev.t;
    netRate = { rx: Math.max(0, (x.rx - netPrev.rx) / dt), tx: Math.max(0, (x.tx - netPrev.tx) / dt) };
  }
  netPrev = { t: now, rx: x.rx, tx: x.tx };
  if (x.cpuUser != null) { cpuHist.push([x.cpuUser + x.cpuSys, x.cpuSys]); if (cpuHist.length > HIST) cpuHist.shift(); }
  if (st.gpuPct != null && gpuOk) { gpuHist.push([st.gpuPct]); if (gpuHist.length > HIST) gpuHist.shift(); }
}

function tempEl(el, c) {
  el.className = el.className.replace(/\bt-\w+/g, '').trim() + ' t-' + M.tempTone(c);
  el.textContent = c == null ? '' : degree(c);
}

// 위쪽이 0~100% 인 작은 면 그래프. 값 배열의 k번째 값을 씀
function sparkPath(hist, k) {
  if (hist.length < 2) return '';
  const w = 120, h = 32, step = w / (HIST - 1), x0 = w - (hist.length - 1) * step;
  let d = `M${x0.toFixed(1)},${h}`;
  hist.forEach((v, i) => { d += ` L${(x0 + i * step).toFixed(1)},${(h - Math.max(0, Math.min(100, v[k])) * h / 100).toFixed(1)}`; });
  return d + ` L${w},${h} Z`;
}

function facts(el, list) {
  el.innerHTML = '';
  for (const t of list) if (t) { const sp = document.createElement('span'); sp.textContent = t; sp.title = t; el.appendChild(sp); }
}
function barTo(el, pct, cls) {
  el.querySelector('s').style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  el.className = 'bar' + (cls ? ' ' + cls : '');
}

function renderSys() {
  const x = hw.sys || {}, t = hw.temps || {};
  // CPU
  const cpu = $('#rCpu');
  cpu.querySelector('.rv').textContent = st.cpuPct == null ? '-' : I.fmt('{0:0}%', st.cpuPct);
  tempEl(cpu.querySelector('.temp'), t.cpu);
  facts(cpu.querySelector('.facts'), [x.cpuUser != null && F('sys.user', x.cpuUser), x.cpuSys != null && F('sys.system', x.cpuSys),
    t.cpuMax != null && F('sys.hottest', t.cpuMax), Probe_chip()]);
  cpu.querySelector('.sa').setAttribute('d', sparkPath(cpuHist, 0));
  cpu.querySelector('.sb').setAttribute('d', sparkPath(cpuHist, 1));
  // GPU
  const gpu = $('#rGpu');
  gpu.querySelector('.rv').textContent = gpuOk && st.gpuPct != null ? I.fmt('{0:0}%', st.gpuPct) : '-';
  tempEl(gpu.querySelector('.temp'), t.gpu);
  facts(gpu.querySelector('.facts'), [x.gpuMem != null && F('sys.gpuMem', fmtBytes(x.gpuMem))]);
  gpu.querySelector('.sa').setAttribute('d', sparkPath(gpuHist, 0));
  // 메모리
  const mem = $('#rMem'), mp = st.memTotal ? 100 * st.memUsed / st.memTotal : null;
  mem.querySelector('.rv').textContent = mp == null ? '-' : I.fmt('{0:0.#}%', mp);
  facts(mem.querySelector('.facts'), [st.memTotal && `${fmtBytes(st.memUsed)} / ${fmtBytes(st.memTotal)}`,
    x.memCompressed != null && F('sys.compressed', fmtBytes(x.memCompressed))]);
  barTo(mem.querySelector('.bar'), mp, mp >= 90 ? 'hot' : '');
  // 저장 공간
  const disk = $('#rDisk'), d = x.disk || {}, used = d.total ? d.total - d.free : null;
  disk.querySelector('.rv').textContent = used == null ? '-' : I.fmt('{0:0.#}%', 100 * used / d.total);
  facts(disk.querySelector('.facts'), [used != null && F('sys.used', fmtBytes(used)), d.total && F('sys.free', fmtBytes(d.free))]);
  barTo(disk.querySelector('.bar'), used == null ? 0 : 100 * used / d.total, used / d.total >= 0.9 ? 'hot' : '');
  // 배터리 (없는 Mac이면 숨김)
  const bat = $('#rBat'), b = x.battery;
  bat.hidden = !b || b.pct == null;
  if (b && b.pct != null) {
    bat.querySelector('.rv').textContent = I.fmt('{0:0}%', b.pct);
    tempEl(bat.querySelector('.temp'), b.temp ?? t.battery);
    const state = b.charging ? T('bat.charging') : b.plugged ? (b.full ? T('bat.full') : T('bat.plugged')) : T('bat.onBattery');
    facts(bat.querySelector('.facts'), [
      state,
      b.plugged && b.adapterW ? F('bat.adapterW', b.adapterW) : '',
      b.loadW != null && F('bat.power', b.loadW),
      b.health != null && F('bat.health', b.health),
      b.cycles != null && F('bat.cycles', b.cycles),
      !b.plugged && b.minLeft ? F('bat.left', fmtDur(b.minLeft * 60)) : '',
    ]);
    barTo(bat.querySelector('.bar'), b.pct, b.charging ? 'lit' : b.pct <= 15 && !b.plugged ? 'hot' : '');
  }
  // 네트워크
  const net = $('#rNet'), n = x.net || {};
  net.querySelector('.rv').textContent = T('net.' + (n.kind || 'none'));
  facts(net.querySelector('.facts'), [F('net.down', fmtRate(netRate.rx)), F('net.up', fmtRate(netRate.tx)), n.ip && F('net.ip', n.ip)]);
}
const Probe_chip = () => st.gpuName || '';

// ---------------------------------------------------------------- 팬 페이지
const fanName = (i, n) => n === 2 ? T(i === 0 ? 'fan.left' : 'fan.right') : n === 1 ? T('fan.one') : F('fan.n', i + 1);
const rpmText = r => Math.round(r).toLocaleString('en-US');
let dialCount = -1, curveDrag = -1;

function buildDials() {
  const box = $('#fanTwins'), n = hw.fans.length;
  if (n === dialCount) return;
  dialCount = n; box.innerHTML = '';
  hw.fans.forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'dial';
    d.innerHTML = `<div class="dial-ring"><svg class="r" viewBox="0 0 128 128"><circle class="track" cx="64" cy="64" r="56"/>` +
      `<circle class="arc" cx="64" cy="64" r="56" transform="rotate(-90 64 64)" stroke-dasharray="0 400"/></svg>` +
      `<svg class="blade"><use href="#i-fan"/></svg><div class="val"><b class="num"></b><small>RPM</small></div></div><span></span><small></small>`;
    d.querySelector('span').textContent = fanName(i, n);
    box.appendChild(d);
  });
}

function fanReady() { return hw.helper === 'ready' || hw.helper === 'outdated'; }

function buildFanCtl() {
  buildDials();
  const n = hw.fans.length, f = S.fan;
  const note = $('#fanNote');
  note.hidden = !(n === 0 || hw.helper === 'unsupported');
  note.textContent = n === 0 ? T('fan.none') : T('fan.unsupported');
  const can = n > 0 && hw.helper !== 'unsupported';
  $('#fanHelper').hidden = !can || hw.helper === 'ready';
  $('#fanHelperWhy').hidden = hw.helper !== 'outdated';
  $('#btnFanInstall').textContent = T(hw.helper === 'outdated' ? 'fan.update' : 'fan.install');
  $('#fanCtl').hidden = !can || !fanReady();
  $$('#fanSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === f.mode));
  $('#fanFixed').hidden = f.mode !== 'fixed';
  $('#fanCurve').hidden = f.mode !== 'curve';
  $('#fanAutoText').hidden = f.mode !== 'auto';
  $('#fanSync').checked = f.sync;
  // 슬라이더: 같이 돌리면 하나, 따로면 팬마다
  const sl = $('#fanSliders'); sl.innerHTML = '';
  const count = f.sync ? 1 : Math.min(2, n);
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'slider';
    row.innerHTML = `<span></span><input type="range" min="0" max="100" step="1"><b class="num"></b>`;
    row.querySelector('span').textContent = f.sync ? T('fan.all') : fanName(i, n);
    const inp = row.querySelector('input');
    inp.value = f.pct[i]; inp.setAttribute('aria-label', row.querySelector('span').textContent);
    inp.oninput = () => { if (f.sync) f.pct = [+inp.value, +inp.value]; else f.pct[i] = +inp.value; save(); renderFan(); };
    sl.appendChild(row);
  }
  drawCurve();
  renderFan();
}

function fanDesired(live) {
  const t = hw.temps || {};
  return hw.fans.map((fan, i) => {
    if (live.mode === 'fixed') return Math.round(fan.min + (fan.max - fan.min) * (live.pct[i] ?? live.pct[0]) / 100);
    if (live.mode === 'curve') return M.curveRpm(live.curve, t.cpu, fan.min, fan.max);
    return null;
  });
}

// 적용된 상태(live)를 매초 도우미에게 전달 — 바뀔 때만
function fanDrive() {
  if (!fanReady() || !hw.fans.length) return;
  const want = fanDesired(S.fan.live);
  const gap = S.fan.live.mode === 'curve' ? 120 : 30;
  const changed = !fanSent || want.length !== fanSent.length ||
    want.some((r, i) => (r == null) !== (fanSent[i] == null) || (r != null && Math.abs(r - fanSent[i]) >= gap));
  if (!changed) return;
  fanSent = want;
  native({ cmd: 'fan', fans: want.map(r => r == null ? { mode: 'auto' } : { mode: 'manual', rpm: r }) });
}

const sameLive = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function draftLive() {
  const f = S.fan;
  return f.mode === 'fixed' ? { mode: 'fixed', pct: f.pct.slice() } : f.mode === 'curve' ? { mode: 'curve', curve: f.curve.map(x => ({ ...x })) } : { mode: 'auto' };
}
function setFanMsg(msg, err) { fanMsg = msg; fanMsgErr = !!err; fanMsgAt = clock(); }

function renderFan() {
  if (dialCount !== hw.fans.length) buildFanCtl();
  const live = S.fan.live, want = fanReady() ? fanDesired(live) : [];
  $$('#fanTwins .dial').forEach((d, i) => {
    const f = hw.fans[i]; if (!f) return;
    const c = 2 * Math.PI * 56, frac = f.max > 0 ? Math.max(0, Math.min(1, f.rpm / f.max)) : 0;
    const arc = d.querySelector('.arc');
    arc.setAttribute('stroke-dasharray', `${(frac * c).toFixed(1)} 400`);
    arc.style.opacity = frac > 0 ? '' : '0';          // 멈춘 팬은 고리 끝의 둥근 점도 숨김
    d.querySelector('.val b').textContent = f.rpm > 0 ? rpmText(f.rpm) : '0';
    d.querySelector('.val small').textContent = f.rpm > 0 ? 'RPM' : T('fan.stopped');
    // Apple Silicon 일부 기종은 수동이어도 F0Md 가 0으로 읽힘 → 앱이 정한 목표로 판단
    d.classList.toggle('manual', want[i] != null || !!f.manual);
    const bl = d.querySelector('.blade');
    bl.style.setProperty('--spin', f.rpm > 0 ? (2400 / f.rpm).toFixed(2) + 's' : '0s');
    bl.style.setProperty('--play', f.rpm > 0 ? 'running' : 'paused');
    const goal = want[i];
    d.querySelector(':scope > small').textContent = goal != null ? F('fan.target', rpmText(goal)) : I.fmt('{0} – {1}', rpmText(f.min), rpmText(f.max));
  });
  const t = hw.temps || {};
  $$('#heatRow [data-temp]').forEach(el => {
    const v = t[el.dataset.temp], b = el.querySelector('b');
    b.textContent = v == null ? '-' : degree(v);
    b.className = 'num t-' + M.tempTone(v);
  });
  // 슬라이더 값
  const n = hw.fans.length;
  $$('#fanSliders .slider').forEach((row, i) => {
    const inp = row.querySelector('input'), p = S.fan.pct[i], fan = hw.fans[i] || hw.fans[0];
    inp.style.setProperty('--fill', p + '%');
    row.querySelector('b').textContent = fan ? rpmText(fan.min + (fan.max - fan.min) * p / 100) : I.fmt('{0}%', p);
    if (S.fan.sync && n > 1) row.querySelector('b').title = hw.fans.map(x => rpmText(x.min + (x.max - x.min) * p / 100)).join(' / ');
  });
  if (S.fan.mode === 'curve') drawCurveNow();
  // 적용 버튼과 상태 문구
  const dirty = !sameLive(draftLive(), live);
  $('#btnFanApply').disabled = !dirty;
  const st8 = $('#fanState');
  if (fanMsg && clock() - fanMsgAt < 6) { st8.textContent = fanMsg; st8.style.color = fanMsgErr ? 'var(--err)' : ''; }
  else { st8.style.color = ''; st8.textContent = dirty ? T('fan.pending') : T('fan.applied.' + live.mode); }
  $('#fanHelper p.hint').hidden = hw.helper !== 'outdated';
}

// 커브 편집기: x = 30~100℃, y = 0~100% (팬 최소~최대)
const CV = { x0: 36, x1: 312, y0: 12, y1: 122, t0: 30, t1: 100 };
const cx = t => CV.x0 + (t - CV.t0) * (CV.x1 - CV.x0) / (CV.t1 - CV.t0);
const cy = p => CV.y1 - p * (CV.y1 - CV.y0) / 100;
function drawCurve() {
  const svg = $('#curve'), pts = S.fan.curve, fan = hw.fans[0];
  svg.setAttribute('aria-label', T('fan.curve'));
  let h = '';
  for (const t of [30, 50, 70, 90]) h += `<line class="grid" x1="${cx(t)}" x2="${cx(t)}" y1="${CV.y0}" y2="${CV.y1}"/><text class="axis" x="${cx(t)}" y="140" text-anchor="middle">${t}°</text>`;
  for (const p of [0, 50, 100]) h += `<line class="grid" x1="${CV.x0}" x2="${CV.x1}" y1="${cy(p)}" y2="${cy(p)}"/>`;
  if (fan) {
    h += `<text class="axis" x="${CV.x0 - 4}" y="${cy(100) + 3}" text-anchor="end">${(fan.max / 1000).toFixed(1)}k</text>`;
    h += `<text class="axis" x="${CV.x0 - 4}" y="${cy(0) + 3}" text-anchor="end">${(fan.min / 1000).toFixed(1)}k</text>`;
  }
  const line = `M${cx(CV.t0)},${cy(pts[0].p)} ` + pts.map(q => `L${cx(q.t)},${cy(q.p)}`).join(' ') + ` L${cx(CV.t1)},${cy(pts[3].p)}`;
  h += `<path class="fill" d="${line} L${cx(CV.t1)},${CV.y1} L${cx(CV.t0)},${CV.y1} Z"/><path class="line" d="${line}"/>`;
  h += `<line class="now" id="cvNow" y1="${CV.y0}" y2="${CV.y1}" x1="-10" x2="-10"/><circle class="nowdot" id="cvDot" r="3.5" cx="-10" cy="-10"/>`;
  pts.forEach((q, i) => { h += `<circle class="pt" data-i="${i}" tabindex="0" r="6.5" cx="${cx(q.t)}" cy="${cy(q.p)}"><title>${q.t}°C → ${Math.round(q.p)}%</title></circle>`; });
  svg.innerHTML = h;
  drawCurveNow();
}
function drawCurveNow() {
  const t = (hw.temps || {}).cpu, fan = hw.fans[0], ln = $('#cvNow'), dot = $('#cvDot');
  if (!ln) return;
  if (t == null || !fan) { $('#curveNow').textContent = ''; return; }
  const tt = Math.max(CV.t0, Math.min(CV.t1, t)), r = M.curveRpm(S.fan.curve, t, fan.min, fan.max);
  const p = fan.max > fan.min ? (r - fan.min) * 100 / (fan.max - fan.min) : 0;
  ln.setAttribute('x1', cx(tt)); ln.setAttribute('x2', cx(tt));
  dot.setAttribute('cx', cx(tt)); dot.setAttribute('cy', cy(p));
  $('#curveNow').textContent = F('fan.now', t, rpmText(r) + ' RPM');
}
// 점을 옮김: 이웃 점과 온도 순서를 지키고, 더 뜨거운 쪽이 더 느려지지 않게
function moveCurvePoint(i, t, p) {
  const pts = S.fan.curve;
  const lo = i > 0 ? pts[i - 1].t + 2 : CV.t0, hi = i < 3 ? pts[i + 1].t - 2 : CV.t1;
  const plo = i > 0 ? pts[i - 1].p : 0, phi = i < 3 ? pts[i + 1].p : 100;
  pts[i] = { t: Math.round(Math.max(lo, Math.min(hi, t))), p: Math.round(Math.max(plo, Math.min(phi, p))) };
  save(); drawCurve(); renderFan();
  const el = $(`#curve .pt[data-i="${i}"]`); if (el && document.activeElement !== el && curveDrag < 0) el.focus();
}

function wireFan() {
  $$('#fanSeg button').forEach(b => b.onclick = () => { S.fan.mode = b.dataset.mode; save(); buildFanCtl(); });
  $('#fanSync').onchange = e => { S.fan.sync = e.target.checked; if (S.fan.sync) S.fan.pct[1] = S.fan.pct[0]; save(); buildFanCtl(); };
  $('#btnFanApply').onclick = () => { S.fan.live = draftLive(); fanSent = null; save(); fanDrive(); setFanMsg(''); renderFan(); };
  $('#btnFanInstall').onclick = () => { $('#btnFanInstall').disabled = true; native({ cmd: 'fanInstall' }); };
  $('#btnFanRemove').onclick = () => { $('#btnFanRemove').disabled = true; S.fan.live = { mode: 'auto' }; save(); native({ cmd: 'fanRemove' }); };
  const svg = $('#curve');
  const toLocal = e => { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
  const fromXY = q => ({ t: CV.t0 + (q.x - CV.x0) * (CV.t1 - CV.t0) / (CV.x1 - CV.x0), p: (CV.y1 - q.y) * 100 / (CV.y1 - CV.y0) });
  svg.addEventListener('pointerdown', e => {
    const c = e.target.closest('.pt'); if (!c) return;
    curveDrag = +c.dataset.i; svg.setPointerCapture(e.pointerId); e.preventDefault();
  });
  svg.addEventListener('pointermove', e => { if (curveDrag < 0) return; const v = fromXY(toLocal(e)); moveCurvePoint(curveDrag, v.t, v.p); });
  const end = () => { curveDrag = -1; };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  svg.addEventListener('keydown', e => {
    const c = e.target.closest('.pt'); if (!c) return;
    const i = +c.dataset.i, q = S.fan.curve[i];
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 2], ArrowDown: [0, -2] }[e.key];
    if (!d) return;
    e.preventDefault(); moveCurvePoint(i, q.t + d[0], q.p + d[1]);
    $(`#curve .pt[data-i="${i}"]`).focus();
  });
}

// ---------------------------------------------------------------- 토큰 페이지
const HEAT_WEEKS = 20;
const MODEL_COLORS = ['var(--lamp)', '#C47A1C', '#F1C27D', 'var(--moon)', 'var(--bar)'];

function askTokens(force) {
  if (tokBusy) return;
  if (!force && tokRows && clock() - tokAt < 60) { renderTok(); return; }
  tokBusy = true;
  if (!tokRows) renderTok();
  native({ cmd: 'tokens' });
}

function dayLabel(d) { return d.toLocaleDateString(culture, { month: 'long', day: 'numeric', weekday: 'short' }); }
function showHeatInfo(cell) {
  heatSel = cell.key;
  $$('#heatGrid .sel').forEach(x => x.classList.remove('sel'));
  const b = $(`#heatGrid [data-k="${cell.key}"]`); if (b) b.classList.add('sel');
  const info = tokSum && tokSum.days.get(cell.key);
  $('#heatInfo').textContent = info
    ? `${dayLabel(cell.date)}   ${F('tok.amount', M.fmtTokens(info.tokens, lang))}   ${money(info.cost)}`
    : `${dayLabel(cell.date)}   ${T('tok.noUse')}`;
}

let tokSum = null;
function renderTok() {
  const loading = !tokRows, empty = tokRows && !tokRows.length;
  $('#tokEmpty').hidden = !(loading || empty);
  $('#tokEmpty').textContent = loading ? T('tok.loading') : T('tok.empty');
  for (const id of ['#tokHead', '#tokStats', '#heat', '#heatInfo', '.tokModelsH', '#tokBar', '#tokModels']) $(id).hidden = loading || empty;
  renderTokWhen();
  if (loading || empty) return;
  const today = M.dayKey(new Date());
  const s = tokSum = M.summarize(tokRows, today);
  $('#tokTotal').textContent = M.fmtTokens(s.total, lang);
  $('#tokCost').textContent = F('tok.cost', money(s.cost));
  $('#tokToday').textContent = M.fmtTokens(s.today.tokens, lang);
  $('#tokDays').textContent = F('tok.dayN', s.activeDays);
  $('#tokStreak').textContent = F('tok.dayN', s.streak);

  // 히트맵: 일요일 시작, 20주
  const g = M.heatGrid(s.days, today, HEAT_WEEKS);
  const mo = $('#heatMonths'); mo.innerHTML = '';
  g.months.forEach(m => {
    const sp = document.createElement('span');
    sp.style.left = (m.col * 16) + 'px';
    sp.textContent = new Date(2026, m.month - 1, 1).toLocaleDateString(culture, { month: 'short' });
    mo.appendChild(sp);
  });
  const wd = $('#heatWd'); wd.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const sp = document.createElement('span');
    if (i % 2 === 1) sp.textContent = new Date(2026, 10, 15 + i).toLocaleDateString(culture, { weekday: 'narrow' });
    wd.appendChild(sp);
  }
  const grid = $('#heatGrid'); grid.innerHTML = '';
  for (const col of g.weeks) for (const c of col) {
    const b = document.createElement('button');
    b.className = (c.future ? 'fut' : 'l' + c.level) + (c.key === heatSel ? ' sel' : '');
    b.dataset.k = c.key;
    if (c.future) { b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); }
    else {
      b.setAttribute('aria-label', `${dayLabel(c.date)} ${c.tokens ? F('tok.amount', M.fmtTokens(c.tokens, lang)) : T('tok.noUse')}`);
      b.onclick = b.onmouseenter = b.onfocus = () => showHeatInfo(c);
    }
    grid.appendChild(b);
  }
  const selCell = g.weeks.flat().find(c => c.key === (heatSel || today)) || g.weeks.flat().find(c => c.key === today);
  if (selCell) showHeatInfo(selCell);

  // 모델별: 위 4개 + 나머지
  const top = s.models.slice(0, 4), rest = s.models.slice(4);
  const items = top.map(m => ({ name: M.modelName(m.model), tokens: m.tokens, cost: m.cost, title: m.model }));
  if (rest.length) items.push({ name: F('tok.others', rest.length), tokens: rest.reduce((a, m) => a + m.tokens, 0),
    cost: rest.reduce((a, m) => a + m.cost, 0), title: rest.map(m => m.model).join(', ') });
  const bar = $('#tokBar'); bar.innerHTML = '';
  const list = $('#tokModels'); list.innerHTML = '';
  items.forEach((m, i) => {
    const seg = document.createElement('i');
    seg.style.flex = String(Math.max(m.tokens, s.total * 0.004)); seg.style.background = MODEL_COLORS[i];
    seg.title = m.name; bar.appendChild(seg);
    const row = document.createElement('div');
    row.className = 'mrow'; row.title = m.title;
    row.innerHTML = '<span class="dot"></span><span></span><b class="num"></b><small class="num"></small>';
    row.querySelector('.dot').style.background = MODEL_COLORS[i];
    row.children[1].textContent = m.name;
    row.querySelector('b').textContent = M.fmtTokens(m.tokens, lang);
    row.querySelector('small').textContent = money(m.cost);
    list.appendChild(row);
  });
}
function renderTokWhen() {
  const el = $('#tokWhen');
  el.textContent = tokBusy ? T('tok.counting') : tokRows ? F('tok.counted', fmtSpan(Math.max(0, clock() - tokAt))) : '';
  $('#btnTokRefresh').disabled = tokBusy;
  if (tokRows && !tokBusy && clock() - tokAt > 60 && view === 'tok') askTokens(true);   // 보고 있으면 1분마다 새로
}
function wireTok() { $('#btnTokRefresh').onclick = () => askTokens(true); }

// ---------------------------------------------------------------- Swift가 부르는 함수
window.AW = {
  init(data) {
    for (const d of data.langs || []) if (d && d.code && d.strings) langs[d.code] = d;
    if (!langs.en) langs.en = { code: 'en', name: 'English', order: 1, strings: {} };
    S = buildSettings(data.settings);
    if (data.startup !== undefined) S.startup = !!data.startup;
    st = L.createState(S);
    todayKey = dateKey(new Date()); todaySec = data.todaySec || 0;
    let code = S.lang && langs[S.lang] ? S.lang : (data.sysLang || 'en').slice(0, 2).toLowerCase();
    if (!langs[code]) code = 'en';
    if (data.error) { lastErr = data.error; errAt = clock() + 10; }
    applyTheme(); wire(); applyLang(code); showView('main'); render();
    if (!data.settings) save();
  },
  tick(sample) { tick(sample); },
  procList(list) { procAll = (list || []).slice().sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name)); fillProcs(); },
  wake(min) { setForce(min); },
  show(v) { if (TABS.includes(v)) { showView(v); render(); } },                       // 메뉴 막대의 "1시간 깨워 두기"
  error(msg) { lastErr = msg; errAt = clock(); render(); },
  tokens(d) { tokBusy = false; tokRows = (d && d.rows) || []; tokAt = clock(); renderTok(); },
  fanResult(r) {
    hw.helper = r.status || hw.helper; fanSent = null;
    $('#btnFanInstall').disabled = false; $('#btnFanRemove').disabled = false;
    if (r.ok) setFanMsg(T(view === 'settings' ? 'fan.removed' : 'fan.installed'));
    else if (r.error) setFanMsg(F('fan.failed', r.error), true);
    buildFanCtl(); render();
  },
};

// ---------------------------------------------------------------- 브라우저 미리보기 (?mock)
if (!window.webkit && /mock/.test(location.search)) {
  window.AW_MOCK = true;
  const codes = ['en', 'ko', 'ja', 'zh', 'es', 'vi', 'th'];
  Promise.all(codes.map(c => fetch(`../lang/${c}.json`).then(r => r.json()).catch(() => null))).then(docs => {
    const qs = new URLSearchParams(location.search);
    AW.init({ langs: docs, sysLang: qs.get('lang') || 'ko', todaySec: 3720,
      settings: qs.get('fresh') ? null : { lang: qs.get('lang') || 'ko', theme: qs.get('theme') || 'light', auto: true, graceSec: 30, idleMin: 1,
        targets: [{ id: 'claude', enabled: true, preset: true }, { id: 'cursor', enabled: true, preset: true }] } });
    let cpu = 0, t0 = clock(), work = +(qs.get('work') || 20);
    // 팬 도우미: ?helper=missing|ready|unsupported, 팬 개수: ?fans=0|1|2
    let helper = qs.get('helper') || 'ready', manual = [null, null];
    const nf = +(qs.get('fans') ?? 2), fanSpec = [{ min: 1200, max: 5779 }, { min: 1200, max: 6241 }].slice(0, nf);
    window.AW_MOCK_REPLY = m => {
      if (m.cmd === 'fan') manual = m.fans.map(f => f.mode === 'manual' ? f.rpm : null);
      if (m.cmd === 'fanInstall') setTimeout(() => { helper = 'ready'; AW.fanResult({ ok: true, status: helper }); }, 600);
      if (m.cmd === 'fanRemove') setTimeout(() => { helper = 'missing'; AW.fanResult({ ok: true, status: helper }); }, 400);
      if (m.cmd === 'tokens') setTimeout(() => {
        const rows = [], models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-sonnet-5'];
        const now = new Date();
        for (let i = 0; i < 110; i++) {
          if (i > 20 && (i % 3 === 0 || i > 70)) continue;
          const d = new Date(now); d.setDate(d.getDate() - i);
          const day = AWMeters.dayKey(d), big = 2e7 * (1 + Math.sin(i) ** 2) * (i < 18 ? 4 : 1);
          rows.push({ day, model: models[0], in: big * 0.001, out: big * 0.01, c5: big * 0.02, c1: big * 0.05, cr: big * 0.9 });
          if (i % 2 === 0) rows.push({ day, model: models[1], in: big * 0.0005, out: big * 0.004, c5: 0, c1: big * 0.01, cr: big * 0.1 });
          if (i % 7 === 1) rows.push({ day, model: models[2], in: 1e4, out: 2e5, c5: 0, c1: 1e5, cr: 4e6 });
          if (i === 5) rows.push({ day, model: models[3], in: 1e5, out: 1e5, c5: 0, c1: 0, cr: 1e6 }, { day, model: models[4], in: 1e4, out: 1e4, c5: 0, c1: 0, cr: 0 }, { day, model: models[5], in: 2e5, out: 3e5, c5: 0, c1: 0, cr: 1e6 });
        }
        AW.tokens({ rows });
      }, 900);
    };
    const once = () => {
      const el = clock() - t0;
      if (el < work) cpu += 0.4;
      const tcpu = 62 + 14 * Math.sin(el / 9), wob = Math.sin(el / 3);
      const nowS = clock(), aiLogs = { claude: [el < work ? { t: nowS - 1, type: 'assistant', stop: 'tool_use', tool: true } : { t: t0 + work, type: 'system', sub: 'stop_hook_summary' }] };
      AW.tick({ aiLogs, procs: [{ pid: 10, ppid: 1, name: 'Claude', cpuSec: cpu, mem: 6e8 }, { pid: 30, ppid: 1, name: 'Cursor', cpuSec: 1, mem: 9e8 }],
        userIdleSec: 999, netBytes: el * 300000, memTotal: 17179869184, memUsed: 11e9, cpuPct: 23 + 18 * wob ** 2, gpuPct: 12 + 30 * Math.abs(wob), gpuName: 'Apple M1 Pro',
        fans: fanSpec.map((f, i) => { const r = manual[i] ?? (tcpu > 66 ? 1800 + 900 * i : 0); return { rpm: r, min: f.min, max: f.max, target: r, manual: manual[i] != null }; }),
        temps: { cpu: tcpu, cpuMax: tcpu + 11, gpu: 55 + 6 * wob, battery: 31.2 },
        fanHelper: nf && qs.get('helper') === 'unsupported' ? 'unsupported' : helper,
        sys: { cpuUser: 15 + 12 * wob ** 2, cpuSys: 8 + 6 * wob ** 2, memCompressed: 4.05e9, gpuMem: 5.6e8, rx: el * 3200, tx: el * 34000,
          disk: { total: 994662584320, free: 760401025858 }, net: { kind: 'wifi', ip: '192.168.1.103' },
          battery: qs.get('nobat') ? null : { pct: 80, plugged: true, charging: false, full: false, cycles: 283, temp: 30.6, health: 85.1, adapterW: 52, inW: 24.2, loadW: 24.2 } } });
    };
    once(); setInterval(once, 1000);
    if (qs.get('view')) { showView(qs.get('view')); render(); }
  });
}
})();
