import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../Resources/ui/logic.js');

const base = (over = {}) => ({
  targets: [{ id: 'claude', label: 'Claude', names: 'claude', mode: 'cpu', enabled: true }],
  cpuTh: 5, graceSec: 120, idleMin: 10, action: 2,
  auto: true, awake: true, display: false, userIdle: true, ...over,
});
// claude 프로세스(pid 10)가 cpuSec 만큼 쓴 상태의 샘플
const smp = (cpuSec, extra = [], userIdleSec = 9999) => ({
  procs: [{ pid: 10, ppid: 1, name: 'Claude', cpuSec, mem: 1e8 },
          { pid: 11, ppid: 10, name: 'Claude Helper (Renderer)', cpuSec: 0, mem: 1e7 }, ...extra],
  userIdleSec, netBytes: 0, memTotal: 16e9, memUsed: 8e9, cpuPct: 10,
});
// t초부터 매초 cpuPerSec 비율로 일하는 샘플을 n번 넣음
function run(st, t0, n, cpuPerSec, userIdle = 9999) {
  let cpu = st._cpu ?? 0, last;
  for (let i = 0; i < n; i++) {
    cpu += cpuPerSec;
    L.ingest(st, smp(cpu, [], userIdle), t0 + i);
    last = L.step(st, t0 + i);
  }
  st._cpu = cpu;
  return last;
}

test('workingHoldsAwake', () => {
  const st = L.createState(base());
  const r = run(st, 1000, 5, 0.5);         // 50% CPU
  assert.equal(r.hold, true);
  assert.equal(L.view(st, 1004).mode, 'working');
});

test('notArmedWithoutWork', () => {
  const st = L.createState(base());
  const r = run(st, 1000, 2000, 0);        // 켜져 있지만 일 안 함
  assert.equal(r.hold, false);
  assert.equal(st.pending, null);
});

test('countdownFiresAfterIdle', () => {
  const st = L.createState(base());
  run(st, 1000, 5, 0.5);
  let alert = false, fired = null;
  for (let t = 1005; t < 1005 + 120 + 600 + 40; t++) {
    L.ingest(st, smp(st._cpu), t);
    const r = L.step(st, t);
    if (r.alert) { alert = true; assert.equal(st.pending.kind, 'sleep'); assert.equal(st.pending.total, 30); }
    if (r.fire) fired = { kind: r.fire, t };
  }
  assert.ok(alert);
  assert.equal(fired.kind, 'sleep');
  assert.ok(fired.t >= 1004 + 120 + 600 + 30);
});

test('screenActionImmediate', () => {
  const st = L.createState(base({ action: 1 }));
  run(st, 1000, 5, 0.5);
  let fired = null;
  for (let t = 1005; t < 1005 + 730; t++) {
    L.ingest(st, smp(st._cpu), t);
    const r = L.step(st, t);
    if (r.fire && !fired) fired = { kind: r.fire, t };
  }
  assert.equal(fired.kind, 'screen');
  // CPU 를 최근 10초 평균으로 보므로 마지막 작업 시각이 최대 10초 늦게 잡힘
  assert.ok(fired.t <= 1004 + 10 + 120 + 600 + 1);
  assert.equal(st.pending, null);
});

test('userBusyDelays', () => {
  const st = L.createState(base());
  run(st, 1000, 5, 0.5);
  let fired = null;
  for (let t = 1005; t < 1005 + 900; t++) {
    L.ingest(st, smp(st._cpu, [], 3), t);   // 사용자가 계속 입력 중
    const r = L.step(st, t);
    if (r.fire || r.alert) fired = t;
  }
  assert.equal(fired, null);
  assert.equal(st.userBusy, true);
});

test('childProcessCounts', () => {
  const st = L.createState(base());
  let child = 0;
  for (let t = 1000; t < 1005; t++) {
    child += 0.2;                          // node 하위 프로세스가 20% 사용
    L.ingest(st, smp(0, [{ pid: 20, ppid: 10, name: 'node', cpuSec: child, mem: 1e7 }]), t);
    L.step(st, t);
  }
  assert.ok(L.idleSeconds(st, 1004) < 2);
});

test('helperCountsAsOwn', () => {
  const st = L.createState(base());
  let h = 0;
  for (let t = 1000; t < 1005; t++) {
    h += 0.3;
    const s = smp(0); s.procs[1].cpuSec = h;   // 렌더러 헬퍼가 일함
    L.ingest(st, s, t); L.step(st, t);
  }
  assert.ok(st.t.claude.pct >= 5);
});

test('aliveModeCounts', () => {
  const st = L.createState(base({ targets: [{ id: 'py', label: 'Py', names: 'python3, python', mode: 'alive', enabled: true }] }));
  for (let t = 1000; t < 1003; t++) {
    L.ingest(st, { procs: [{ pid: 5, ppid: 1, name: 'Python3', cpuSec: 0, mem: 0 }], userIdleSec: 9999, netBytes: 0 }, t);
    var r = L.step(st, t);
  }
  assert.equal(r.hold, true);
});

test('resetAfterWake', () => {
  const st = L.createState(base());
  run(st, 1000, 3, 0);
  L.resetBaseline(st);
  L.ingest(st, smp(500), 5000);            // 잠든 사이 누적된 큰 값
  assert.equal(st.t.claude.pct, 0);
  assert.ok(L.idleSeconds(st, 5000) > 1000);
});

test('forceAwake', () => {
  const st = L.createState(base());
  L.setForce(st, 30, 1000);
  assert.equal(L.step(st, 1000).hold, true);
  assert.equal(L.view(st, 1000).mode, 'force');
  assert.equal(L.step(st, 1000 + 1801).hold, false);
});

test('finishedSessionReported', () => {
  const st = L.createState(base({ auto: false }));
  run(st, 1000, 120, 0.5);                 // 2분 작업
  let fin = null;
  for (let t = 1120; t < 1300; t++) { L.ingest(st, smp(st._cpu), t); const r = L.step(st, t); if (r.finished) fin = r.finished; }
  assert.ok(fin && fin.sec >= 110);
  assert.equal(fin.programs, 'Claude');
});

// ---- 실제 측정(2026-11-17)에서 나온 거짓 "작업 중" ----
// Claude 앱은 쉬고 있어도 프로세스가 많음: claude CLI 세션 여러 개(각 ~1%, 가끔 10% 반짝), 헬퍼·렌더러(~1~2%).
function idleCrowd(t) {
  const procs = [{ pid: 10, ppid: 1, name: 'Claude', cpuSec: t * 0.01, mem: 1e8 }];
  for (let i = 0; i < 6; i++) {           // 쉬는 claude CLI 세션 6개: 1%/초 + 10초마다 10% 반짝
    const spikes = Math.floor((t + i * 3) / 10);
    procs.push({ pid: 100 + i, ppid: 10, name: 'claude', cpuSec: t * 0.01 + spikes * 0.1, mem: 1e8 });
  }
  procs.push({ pid: 200, ppid: 10, name: 'Claude Helper (Renderer)', cpuSec: t * 0.024, mem: 1e8 });
  procs.push({ pid: 201, ppid: 10, name: 'Claude Helper', cpuSec: t * 0.012, mem: 1e8 });
  return procs;
}

test('manyIdleProcessesStayIdle', () => {
  const st = L.createState(base({ auto: false }));
  let r;
  for (let t = 1000; t < 1300; t++) {
    L.ingest(st, { procs: idleCrowd(t - 1000), userIdleSec: 9999 }, t);
    r = L.step(st, t);
  }
  assert.equal(st.t.claude.status, 'idle');
  assert.equal(r.hold, false);
  assert.equal(L.view(st, 1299).mode, 'idle');
});

test('helperSpawnedGitIsNotACommand', () => {
  const st = L.createState(base({ auto: false }));
  let r;
  for (let t = 1000; t < 1300; t++) {
    const procs = idleCrowd(t - 1000);
    if (t % 20 === 0) procs.push({ pid: 5000 + t, ppid: 201, name: 'git', cpuSec: 0.02, mem: 1e6 });   // 헬퍼가 git 을 자주 띄움
    L.ingest(st, { procs, userIdleSec: 9999 }, t);
    r = L.step(st, t);
  }
  assert.notEqual(st.t.claude.status, 'cmd');
  assert.equal(r.hold, false);
});

test('oneBusySessionAmongIdleCounts', () => {
  const st = L.createState(base({ auto: false }));
  let busy = 0, r;
  for (let t = 1000; t < 1020; t++) {
    busy += 0.15;                           // 일하는 세션 하나: 15%
    const procs = idleCrowd(t - 1000);
    procs.push({ pid: 300, ppid: 10, name: 'claude', cpuSec: busy, mem: 1e8 });
    L.ingest(st, { procs, userIdleSec: 9999 }, t);
    r = L.step(st, t);
  }
  assert.equal(st.t.claude.status, 'working');
  assert.equal(r.hold, true);
});

test('terminalCommandUnderSessionCounts', () => {
  const st = L.createState(base({ auto: false }));
  let r;
  for (let t = 1000; t < 1010; t++) {
    const procs = idleCrowd(t - 1000);
    procs.push({ pid: 400, ppid: 100, name: 'zsh', cpuSec: 0, mem: 1e6 });
    if (t >= 1005) procs.push({ pid: 401, ppid: 400, name: 'npm', cpuSec: 0, mem: 1e6 });   // 세션이 명령을 실행
    L.ingest(st, { procs, userIdleSec: 9999 }, t);
    r = L.step(st, t);
  }
  assert.equal(st.t.claude.status, 'cmd');
  assert.equal(r.hold, true);
});

test('manySmallChildrenAreNotACommand', () => {
  // MCP 서버 같은 하위 프로세스 8개가 각각 0.3%씩: 합치면 2.4% 이지만 아무 일도 안 하는 중
  const st = L.createState(base({ auto: false }));
  let r;
  for (let t = 1000; t < 1300; t++) {
    const procs = idleCrowd(t - 1000);
    for (let i = 0; i < 8; i++) procs.push({ pid: 500 + i, ppid: 100, name: 'node', cpuSec: (t - 1000) * 0.003, mem: 1e7 });
    L.ingest(st, { procs, userIdleSec: 9999 }, t);
    r = L.step(st, t);
  }
  assert.equal(st.t.claude.status, 'idle');
  assert.equal(r.hold, false);
});
