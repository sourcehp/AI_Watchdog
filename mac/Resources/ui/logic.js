// AI Watchdog 판정 로직 (화면과 무관). 브라우저(window.AWLogic)와 node(require) 양쪽에서 씀.
// 시간 단위는 모두 초.
(function (root) {
  'use strict';
  const NEVER = -1e12;
  const SHELLS = ['zsh', 'bash', 'sh', 'fish', 'login'];
  const HELPERS = ['crashpad_handler', 'chrome_crashpad_handler', ...SHELLS];
  // 자기 CPU 는 "프로세스 하나의 최근 WINDOW번 평균"으로 봄.
  // 전부 더하면 쉬는 세션·헬퍼 수십 개의 1~2%가 쌓여 늘 기준을 넘음 (2026-11-17 실측: 쉬는데도 합계 8~16%).
  const WINDOW = 10;
  const isHelperName = (procName, names) => names.some(n => String(procName).toLowerCase().startsWith(n + ' helper'));

  // ---------------------------------------------------------------- AI 대화 기록으로 판정
  // "AI 가 일하는 중" = 프로그램이 켜진 게 아니라 그 안에서 AI 가 실제로 일하는 것.
  // Claude Code(~/.claude/projects)·Codex(~/.codex/sessions)는 대화 기록 파일에 시각이 찍힌 줄을 남김.
  // Swift 가 최근 바뀐 파일마다 "시각이 찍힌 마지막 줄" {t, type, sub, stop, tool} 을 보냄. (관리용 줄은 시각이 없어 빠짐)
  const LOG_FRESH = 10;            // 방금 쓴 줄이면 일하는 중
  const LOG_REQUEST = 15 * 60;     // 모델에 요청을 보내고 답을 기다리는 중 (길게 생각)
  const LOG_TOOL = 30 * 60;        // AI 가 도구를 실행하는 중
  const LOG_OTHER = 120;           // 그 밖의 줄 다음에는 곧 무언가 이어져야 함
  function logEnded(e) {           // 턴이 끝났다는 줄
    return (e.type === 'system' && (e.sub === 'stop_hook_summary' || e.sub === 'turn_duration')) ||
      (e.type === 'assistant' && e.stop === 'end_turn' && !e.tool) ||
      e.sub === 'task_complete' || e.sub === 'turn_aborted';
  }
  function logWorking(entries, now) {
    let count = 0;
    const reasons = [];
    for (const e of entries || []) {
      if (!e || typeof e.t !== 'number' || logEnded(e)) continue;
      const age = now - e.t;
      const limit = e.type === 'api-request' ? LOG_REQUEST : e.type === 'assistant' && e.tool ? LOG_TOOL : LOG_OTHER;
      if (age <= LOG_FRESH || age <= limit) { count++; reasons.push(`${e.type}${e.sub ? '/' + e.sub : ''}${e.tool ? '+tool' : ''} ${Math.round(age)}s`); }
    }
    return { working: count > 0, count, reasons };
  }

  // 진단용: "어떤 프로세스(부모) 가 몇 %" 를 글로
  function cmdWhy(p, pct, byId) {
    if (!p) return '';
    const par = byId.get(p.ppid), gp = par && byId.get(par.ppid);
    return `cpu ${p.name}(${p.pid}) <- ${par ? par.name : '?'} <- ${gp ? gp.name : '?'} ${pct.toFixed(1)}%`;
  }

  function splitNames(text) {
    return String(text || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  // "claude"는 "Claude", "Claude Helper", "Claude Helper (Renderer)"와 맞음
  function matches(procName, names) {
    const p = String(procName).toLowerCase();
    return names.some(n => p === n || p.startsWith(n + ' helper'));
  }

  function createState(settings) {
    return {
      settings, t: {},
      lastCpu: NEVER, lastLocal: NEVER, running: false, armed: false,
      workStart: 0, wasWorking: false, sessionLabels: new Set(), activeLabels: [],
      forceUntil: NEVER, forceTotal: 3600,
      pending: null, autoRemain: -1, autoLimit: 600, userBusy: false,
      userIdleSec: 0, cpuPct: null, memTotal: 0, memUsed: 0,
      netRate: 0, prevNet: -1, prevNetT: 0, now: 0,
    };
  }

  function tstate(st, id) {
    if (!st.t[id]) st.t[id] = { prevCpu: 0, prevTime: 0, first: true, known: new Set(),
      ownBook: { prev: new Map(), hist: new Map() }, descBook: { prev: new Map(), hist: new Map() },
      lastAct: NEVER, lastLocal: NEVER, pct: 0, mem: 0, running: false, status: 'checking' };
    return st.t[id];
  }

  const enabled = st => st.settings.targets.filter(t => t.enabled);
  const idleSeconds = (st, now) => now - Math.max(st.lastCpu, st.lastLocal);
  const forceOn = (st, now) => now < st.forceUntil;

  function ingest(st, s, now) {
    st.now = now;
    st.userIdleSec = s.userIdleSec ?? 0;
    st.cpuPct = s.cpuPct ?? null;
    if (s.memTotal != null) { st.memTotal = s.memTotal; st.memUsed = s.memUsed || 0; }
    if (s.netBytes != null) {
      if (st.prevNet >= 0 && now > st.prevNetT) st.netRate = Math.max(0, s.netBytes - st.prevNet) / (now - st.prevNetT);
      st.prevNet = s.netBytes; st.prevNetT = now;
    }

    const procs = s.procs || [];
    const byId = new Map(), kids = new Map();
    for (const p of procs) {
      byId.set(p.pid, p);
      if (!kids.has(p.ppid)) kids.set(p.ppid, []);
      kids.get(p.ppid).push(p);
    }
    const idleBefore = idleSeconds(st, now);
    let anyRunning = false;

    for (const t of enabled(st)) {
      const ts = tstate(st, t.id);
      const own = splitNames(t.names);
      const plist = procs.filter(p => matches(p.name, own));
      ts.running = plist.length > 0;
      if (ts.running) anyRunning = true;
      const first = ts.first;

      let cpu = 0, mem = 0;
      for (const p of plist) { cpu += p.cpuSec || 0; mem += p.mem || 0; }
      const dt = now - ts.prevTime > 0 ? now - ts.prevTime : 1;
      // 프로세스마다 최근 WINDOW번의 CPU % (없던 칸은 0으로 보고 평균) → 가장 큰 값을 돌려줌.
      // book = {prev: Map(pid→cpuSec), hist: Map(pid→[%...])} 를 이번 프로세스 목록으로 갈아 끼움
      const busiestOf = (list, book) => {
        let best = 0; book.top = null;
        const hist = new Map(), prev = new Map();
        for (const p of list) {
          const c = p.cpuSec || 0, before = book.prev.get(p.pid);
          const h = first ? [] : (book.hist.get(p.pid) || []).slice(-(WINDOW - 1));
          if (!first && before != null) h.push(Math.max(0, c - before) * 100 / dt);
          hist.set(p.pid, h); prev.set(p.pid, c);
          const avg = h.reduce((a, b) => a + b, 0) / WINDOW;
          if (avg > best) { best = avg; book.top = p; }
        }
        book.hist = hist; book.prev = prev;
        return best;
      };
      const busiest = busiestOf(plist, ts.ownBook);
      // 하위 프로세스 (자기 이름·보조 프로세스 제외).
      // 앱 헬퍼가 직접 띄운 프로그램(Claude Helper → git 등 주기적 확인)은 AI 작업이 아니라서 뺌.
      // 단, 헬퍼가 띄운 셸(터미널) 아래 명령은 셈.
      // aiShell: AI 세션(헬퍼가 아닌 자기 프로세스, 예: claude CLI)이 띄운 셸과 그 아래 — AI 가 Bash 로 실행한 명령
      const desc = new Set(), aiShell = new Set(), seen = new Set(plist.map(p => p.pid)), queue = plist.map(p => p.pid);
      while (queue.length) {
        const parentPid = queue.shift(), parent = byId.get(parentPid);
        const fromHelper = parent && isHelperName(parent.name, own);
        const fromSession = parent && matches(parent.name, own) && !fromHelper;
        for (const c of kids.get(parentPid) || []) {
          if (seen.has(c.pid)) continue;
          seen.add(c.pid);
          const nm = String(c.name).toLowerCase();
          if (fromHelper && !SHELLS.includes(nm)) continue;     // 그 아래도 보지 않음
          queue.push(c.pid);
          if (aiShell.has(parentPid) || (fromSession && SHELLS.includes(nm))) aiShell.add(c.pid);
          if (!matches(nm, own) && !HELPERS.includes(nm)) desc.add(c.pid);
        }
      }
      for (const id of desc) mem += byId.get(id).mem || 0;
      // 대화 기록이 있는 앱(Claude·Codex)은 기록으로 "AI 작업"을 보고, 명령은 AI 세션이 셸로 실행한 것만 셈.
      // 대화를 열 때 켜지는 MCP 서버(claude → npm exec/node/Python), 앱 안 터미널(Claude Helper → zsh)은 AI 작업이 아님 (2026-11-17 실측).
      const logs = t.logs && s.aiLogs ? s.aiLogs[t.logs] : undefined;
      ts.logBased = Array.isArray(logs) && t.mode !== 'alive';
      const counted = ts.logBased ? [...desc].filter(id => aiShell.has(id)) : [...desc];
      // 하위 프로세스도 하나씩 봄 (MCP 서버처럼 조용히 떠 있는 것 여러 개의 0.2~0.4%가 쌓이지 않게)
      const descBusiest = busiestOf(counted.map(id => byId.get(id)), ts.descBook);

      let newFound = false;
      if (!first) for (const id of desc) if (!ts.known.has(id)) { newFound = true; break; }
      ts.known = desc;

      let pct = busiest;
      let lpct = descBusiest;
      if (first) { pct = 0; lpct = 0; }
      ts.prevCpu = cpu; ts.prevTime = now;
      ts.first = !ts.running;
      ts.pct = pct; ts.mem = mem;

      // 대화 기록이 있는 앱은 기록으로만 "AI 작업"을 봄 — 창을 그리는 CPU 는 셈하지 않음.
      // 그래도 AI 가 셸로 실행한 명령이 실제로 CPU 를 쓰면(빌드 등) "명령 실행 중".
      ts.aiCount = 0;
      if (ts.running && ts.logBased) {
        const lw = logWorking(logs, now);
        ts.aiCount = lw.count;
        ts.why = lw.working ? 'log ' + lw.reasons.join(', ') : '';
        if (lw.working) ts.lastAct = now;
        if (!first && lpct >= 1) { ts.lastLocal = now; ts.why = cmdWhy(ts.descBook.top, lpct, byId); }
      } else if (ts.running && !first) {
        if (t.mode === 'alive' || pct >= st.settings.cpuTh) ts.lastAct = now;
        if (newFound || lpct >= 1) { ts.lastLocal = now; ts.why = newFound ? 'new child process' : cmdWhy(ts.descBook.top, lpct, byId); }
        else if (t.mode !== 'alive' && pct >= st.settings.cpuTh) ts.why = cmdWhy(ts.ownBook.top, pct, byId);
      }
    }

    let la = NEVER, ll = NEVER;
    const active = [];
    for (const t of enabled(st)) {
      const ts = tstate(st, t.id);
      la = Math.max(la, ts.lastAct); ll = Math.max(ll, ts.lastLocal);
      if (!ts.running) ts.status = 'off';
      else if (ts.logBased && ts.aiCount > 0) ts.status = 'ai';
      else if (now - ts.lastLocal < 30) ts.status = 'cmd';
      else if (ts.logBased) ts.status = 'idle';
      else if (t.mode === 'alive') ts.status = 'running';
      else if (now - ts.lastAct < 15) ts.status = 'working';
      else ts.status = 'idle';
      if (ts.running && ts.status !== 'idle') active.push(t.label);
    }
    st.running = anyRunning; st.lastCpu = la; st.lastLocal = ll; st.activeLabels = active;
    if (idleSeconds(st, now) < 2 && idleBefore >= st.settings.graceSec) st.workStart = now;
  }

  // 1초마다 호출. 결과: hold(깨워 둘지), display, fire(지금 실행할 동작), alert(예고 시작), finished(작업 기록)
  function step(st, now) {
    const S = st.settings, r = { hold: false, display: !!S.display, fire: null, alert: false, finished: null };
    const idle = idleSeconds(st, now);
    const working = st.running && idle < S.graceSec;

    // 작업 기록
    if (working && !st.wasWorking) st.sessionLabels = new Set();
    if (working) st.activeLabels.forEach(l => st.sessionLabels.add(l));
    if (st.wasWorking && !working) {
      let end = Math.max(st.lastCpu, st.lastLocal);
      if (end < st.workStart) end = now;
      const sec = end - st.workStart;
      if (sec >= 60) r.finished = { start: st.workStart, end, sec, programs: [...st.sessionLabels].join(', ') };
    }
    st.wasWorking = working;

    r.hold = forceOn(st, now) || (S.awake && working);

    // 작업이 끝나면 자동 실행
    st.autoRemain = -1; st.userBusy = false;
    if (st.running && idle < 10) st.armed = true;
    if (S.auto && st.armed && !st.pending && !forceOn(st, now) && idle >= S.graceSec) {
      let eff = idle - S.graceSec;
      if (S.userIdle && st.userIdleSec < eff) { eff = st.userIdleSec; st.userBusy = st.userIdleSec < 30; }
      st.autoLimit = S.idleMin * 60;
      st.autoRemain = Math.max(0, st.autoLimit - eff);
      if (eff >= st.autoLimit) {
        st.armed = false; st.autoRemain = -1;
        const kind = kindOf(S.action);
        if (kind === 'screen') r.fire = 'screen';
        else { startPending(st, kind, 30, now); r.alert = true; }
      }
    }

    if (st.pending && now >= st.pending.until) { r.fire = st.pending.kind; st.pending = null; }
    return r;
  }

  const kindOf = a => ({ 1: 'screen', 2: 'sleep', 3: 'shutdown' }[a] || 'sleep');
  function startPending(st, kind, sec, now) { st.pending = { kind, until: now + sec, total: sec }; }
  function cancelPending(st) { st.pending = null; }
  function setForce(st, minutes, now) {
    if (minutes <= 0) { st.forceUntil = NEVER; return; }
    st.forceUntil = now + minutes * 60; st.forceTotal = minutes * 60; st.pending = null;
  }
  function resetBaseline(st) { for (const k in st.t) st.t[k].first = true; }

  function view(st, now) {
    const idle = idleSeconds(st, now), S = st.settings;
    let mode;
    if (st.pending) mode = 'pending';
    else if (forceOn(st, now)) mode = 'force';
    else if (st.running && idle < S.graceSec) mode = 'working';
    else if (st.autoRemain >= 0) mode = 'countdown';
    else if (enabled(st).length === 0) mode = 'none';
    else if (!st.running) mode = 'off';
    else mode = 'idle';
    return { mode, idle };
  }

  const api = { logWorking, createState, ingest, step, view, idleSeconds, startPending, cancelPending, setForce, resetBaseline, splitNames, matches, kindOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AWLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
