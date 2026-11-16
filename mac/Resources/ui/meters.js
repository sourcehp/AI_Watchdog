// 시스템·팬·토큰 페이지의 계산 (화면과 무관). 브라우저(window.AWMeters)와 node(require) 양쪽에서 씀.
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- 요금 ($ / 100만 토큰, Anthropic API 정가)
  // in 입력 · out 출력 · c5 캐시 쓰기(5분) · c1 캐시 쓰기(1시간) · cr 캐시 읽기
  const P = (i, o, c5, c1, cr) => ({ in: i, out: o, c5, c1, cr });
  const PRICES = {
    'claude-fable-5-2': P(8, 40, 10, 16, 0.2), 'claude-mythos-5-2': P(8, 40, 10, 16, 0.2),
    'claude-fable-5-1': P(10, 50, 12.5, 20, 0.25), 'claude-mythos-5-1': P(10, 50, 12.5, 20, 0.25),
    'claude-fable-5': P(10, 50, 12.5, 20, 1), 'claude-mythos-5': P(10, 50, 12.5, 20, 1),
    'claude-opus-5-5': P(4, 20, 5, 8, 0.2),
    'claude-opus-5': P(5, 25, 6.25, 10, 0.5),
    'claude-opus-4-8': P(5, 25, 6.25, 10, 0.5), 'claude-opus-4-7': P(5, 25, 6.25, 10, 0.5),
    'claude-opus-4-6': P(5, 25, 6.25, 10, 0.5), 'claude-opus-4-5': P(5, 25, 6.25, 10, 0.5),
    'claude-opus-4': P(15, 75, 18.75, 30, 1.5),
    'claude-sonnet-5-5': P(2, 10, 2.5, 4, 0.1),
    'claude-sonnet-5': P(2, 10, 2.5, 4, 0.2),
    'claude-sonnet-4': P(3, 15, 3.75, 6, 0.3),
    'claude-haiku-5-5': P(0.1, 0.5, 0.125, 0.2, 0.01),
    'claude-haiku-4-5': P(1, 5, 1.25, 2, 0.1),
  };
  const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
  const FAMILY = [['opus', 'claude-opus-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-5-5'],
    ['fable', 'claude-fable-5-2'], ['mythos', 'claude-mythos-5-2']];

  function price(model) {
    const m = String(model || '').toLowerCase();
    const k = KEYS.find(k => m === k || m.startsWith(k + '-') || m.startsWith(k + '@'));
    if (k) return PRICES[k];
    const f = FAMILY.find(([w]) => m.includes(w));
    return f ? PRICES[f[1]] : null;
  }
  const rowTokens = r => (r.in || 0) + (r.out || 0) + (r.c5 || 0) + (r.c1 || 0) + (r.cr || 0);
  function rowCost(r) {
    const p = price(r.model);
    if (!p) return 0;
    return ((r.in || 0) * p.in + (r.out || 0) * p.out + (r.c5 || 0) * p.c5 + (r.c1 || 0) * p.c1 + (r.cr || 0) * p.cr) / 1e6;
  }

  // ---------------------------------------------------------------- 날짜 (현지 시간, yyyy-mm-dd)
  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  // ---------------------------------------------------------------- 토큰 요약
  function summarize(rows, todayKey) {
    const days = new Map(), models = new Map();
    let total = 0, cost = 0;
    for (const r of rows || []) {
      const t = rowTokens(r), c = rowCost(r);
      if (!t) continue;
      total += t; cost += c;
      const d = days.get(r.day) || { tokens: 0, cost: 0, models: {} };
      d.tokens += t; d.cost += c; d.models[r.model] = (d.models[r.model] || 0) + t;
      days.set(r.day, d);
      const m = models.get(r.model) || { model: r.model, tokens: 0, cost: 0 };
      m.tokens += t; m.cost += c;
      models.set(r.model, m);
    }
    let streak = 0, d = parseDay(todayKey);
    if (!days.has(todayKey)) d = addDays(d, -1);
    while (days.has(dayKey(d))) { streak++; d = addDays(d, -1); }
    const today = days.get(todayKey) || { tokens: 0, cost: 0 };
    return { total, cost, days, today: { tokens: today.tokens, cost: today.cost }, activeDays: days.size, streak,
      models: [...models.values()].sort((a, b) => b.tokens - a.tokens) };
  }

  // 일요일부터 시작하는 weeks주 × 7일 칸. level 0(없음)~4(가장 많음)은 기간 안 순위로
  function heatGrid(days, endKey, weeks) {
    const end = parseDay(endKey);
    const start = addDays(end, -end.getDay() - (weeks - 1) * 7);
    const cols = [], vals = [];
    for (let w = 0; w < weeks; w++) {
      const col = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(start, w * 7 + i), key = dayKey(d), info = days.get(key);
        const cell = { key, date: d, tokens: info ? info.tokens : 0, future: d > end, level: 0 };
        if (cell.tokens > 0 && !cell.future) vals.push(cell.tokens);
        col.push(cell);
      }
      cols.push(col);
    }
    vals.sort((a, b) => a - b);
    const n = vals.length;
    for (const col of cols) for (const c of col) {
      if (c.tokens <= 0 || c.future) continue;
      const rank = vals.indexOf(c.tokens) + 1;
      c.level = Math.max(1, Math.ceil(4 * rank / n));
    }
    const months = [];
    cols.forEach((col, i) => {
      const first = col.find(c => !c.future && c.date.getDate() === 1);
      if (first) months.push({ col: i, month: first.date.getMonth() + 1 });
    });
    if (!months.length || months[0].col >= 3) months.unshift({ col: 0, month: cols[0][0].date.getMonth() + 1 });
    return { weeks: cols, months };
  }

  // ---------------------------------------------------------------- 팬 커브: 온도 → RPM (점의 p는 min..max 사이 %)
  function curveRpm(points, temp, min, max) {
    if (temp == null || !isFinite(temp)) return null;
    const pts = [...points].sort((a, b) => a.t - b.t);
    let p;
    if (temp <= pts[0].t) p = pts[0].p;
    else if (temp >= pts[pts.length - 1].t) p = pts[pts.length - 1].p;
    else {
      const i = pts.findIndex(x => x.t >= temp), a = pts[i - 1], b = pts[i];
      p = a.p + (b.p - a.p) * (temp - a.t) / (b.t - a.t);
    }
    return Math.round(min + (max - min) * Math.max(0, Math.min(100, p)) / 100);
  }

  function tempTone(c) {
    if (c == null || !isFinite(c)) return 'none';
    return c < 50 ? 'cool' : c < 70 ? 'mild' : c < 85 ? 'warm' : 'hot';
  }

  // ---------------------------------------------------------------- 큰 수 (한·중·일은 만/억, 나머지는 K/M/B)
  const EAST = { ko: ['만', '억'], zh: ['万', '亿'], ja: ['万', '億'] };
  function fmtTokens(n, lang) {
    n = Math.max(0, Number(n) || 0);
    const g = (v, d) => v.toLocaleString('en-US', { maximumFractionDigits: d });
    const e = EAST[lang];
    if (e) {
      if (n >= 1e8) return g(n / 1e8, 1) + e[1];
      if (n >= 1e4) return g(n / 1e4, 1) + e[0];
      return g(n, 0);
    }
    const s = (v, u) => String(Number(v.toPrecision(3))) + u;
    if (n >= 1e9) return s(n / 1e9, 'B');
    if (n >= 1e6) return s(n / 1e6, 'M');
    if (n >= 1e3) return s(n / 1e3, 'K');
    return g(n, 0);
  }

  // claude-opus-5-5 → Opus 5.5 (날짜 꼬리는 버림)
  function modelName(id) {
    const m = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)(?:-\d{8})?$/.exec(String(id || ''));
    if (!m) return String(id || '');
    return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2].split('-').join('.');
  }

  const api = { modelName, price, rowCost, rowTokens, summarize, heatGrid, curveRpm, tempTone, fmtTokens, dayKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AWMeters = api;
})(typeof window !== 'undefined' ? window : globalThis);
