// AI Watchdog 화면. Swift(App.swift)가 AW.init / AW.tick / AW.procList 를 부르고,
// 이 파일은 native({cmd:...}) 로 Swift에 요청한다.
(() => {
'use strict';
const L = window.AWLogic, I = window.AWI18n;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const clock = () => Date.now() / 1000;

const PRESETS = [
  { id: 'claude', label: 'Claude', names: 'claude', mode: 'cpu' },
  { id: 'chatgpt', label: 'ChatGPT', names: 'chatgpt', mode: 'cpu' },
  { id: 'codex', label: 'Codex', names: 'codex', mode: 'cpu' },
  { id: 'cursor', label: 'Cursor', names: 'cursor', mode: 'cpu' },
  { id: 'antigravity', label: 'Antigravity', names: 'antigravity', mode: 'cpu' },
  { id: 'ollama', label: 'Ollama', names: 'ollama', mode: 'cpu' },
  { id: 'lmstudio', label: 'LM Studio', names: 'lm studio', mode: 'cpu' },
  { id: 'python', label: 'Python', names: 'python3, python', mode: 'alive' },
];
const DEFAULTS = { version: 1, lang: null, theme: 'system', cpuTh: 5, graceSec: 120, idleMin: 10, action: 2,
  auto: false, awake: true, display: false, userIdle: true, notify: true, meters: true, startup: false };
const ICON = { 1: 'screen', 2: 'moon', 3: 'power' };
const KIND_N = { screen: 1, sleep: 2, shutdown: 3 };

let langs = {}, T = k => k, S = null, st = null, view = 'main', lang = 'en', culture = 'en-US';
let todayKey = '', todaySec = 0, lastErr = '', errAt = 0, lastHold = null, lastStatus = '', procAll = [], pickSel = null;
let saveTimer = 0, gpuOk = true;

const native = msg => {
  try { window.webkit.messageHandlers.aw.postMessage(msg); }
  catch { if (window.AW_MOCK) console.debug('native', msg); }
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
  const fresh = !saved || !Array.isArray(saved.targets);
  const old = new Map((saved && saved.targets || []).map(t => [t.id, t]));
  s.targets = PRESETS.map(p => {
    const o = old.get(p.id);
    return { id: p.id, label: p.label, names: p.names, preset: true,
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
  $('#vMain').hidden = v !== 'main'; $('#vTargets').hidden = v !== 'targets'; $('#vSettings').hidden = v !== 'settings';
  $('#title').textContent = v === 'targets' ? T('title.targets') : v === 'settings' ? T('x.tip.settings') : 'AI Watchdog';
  const b = $('#btnSettings');
  b.innerHTML = `<svg><use href="#i-${v === 'main' ? 'gear' : 'back'}"/></svg>`;
  b.title = v === 'main' ? T('x.tip.settings') : T('tip.back');
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
      working: F('agent.working', ts.pct), idle: T('hero.idle'), checking: T('agent.checking') }[ts.status];
    row.classList.toggle('lit', ['cmd', 'running', 'working'].includes(ts.status));
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

  // 아래 안내
  const foot = $('#footer');
  if (lastErr && now - errAt < 10) { foot.className = 'err'; foot.textContent = lastErr; }
  else {
    lastErr = ''; foot.className = '';
    if (view !== 'main') foot.textContent = T('foot.saved');
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
  advance(now);
}
function advance(now) {
  const r = L.step(st, now);
  if (r.hold !== lastHold || (r.hold && S.display !== st._disp)) {
    lastHold = r.hold; st._disp = S.display;
    native({ cmd: 'hold', on: r.hold, display: !!S.display });
  }
  if (r.alert) { showView('main'); native({ cmd: 'show', alert: true }); }
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
  $('#btnSettings').onclick = () => { showView(view === 'main' ? 'settings' : 'main'); render(); };
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
    else if (view !== 'main') { showView('main'); render(); }
  });
  new ResizeObserver(() => native({ cmd: 'size', h: Math.ceil($('#card').getBoundingClientRect().height) })).observe($('#card'));
}
function setForce(min) { const now = clock(); L.setForce(st, min, now); sync(); advance(now); }
function cancel() { L.cancelPending(st); native({ cmd: 'show', alert: false }); render(); }

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
  wake(min) { setForce(min); },                       // 메뉴 막대의 "1시간 깨워 두기"
  error(msg) { lastErr = msg; errAt = clock(); render(); },
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
    const once = () => {
      const el = clock() - t0;
      if (el < work) cpu += 0.4;
      AW.tick({ procs: [{ pid: 10, ppid: 1, name: 'Claude', cpuSec: cpu, mem: 6e8 }, { pid: 30, ppid: 1, name: 'Cursor', cpuSec: 1, mem: 9e8 }],
        userIdleSec: 999, netBytes: el * 300000, memTotal: 17179869184, memUsed: 11e9, cpuPct: 23, gpuPct: 12, gpuName: 'Apple M2' });
    };
    once(); setInterval(once, 1000);
    if (qs.get('view')) { showView(qs.get('view')); render(); }
  });
}
})();
