import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const M = createRequire(import.meta.url)('../Resources/ui/meters.js');

const row = (day, model, o = {}) => ({ day, model, in: 0, out: 0, c5: 0, c1: 0, cr: 0, ...o });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('priceKnownAndFamilyFallback', () => {
  assert.deepEqual(M.price('claude-opus-5-5'), { in: 4, out: 20, c5: 5, c1: 8, cr: 0.2 });
  assert.equal(M.price('claude-sonnet-5-5').cr, 0.1);
  assert.equal(M.price('claude-fable-5-1').in, 10);
  // 모르는 새 버전은 같은 계열의 최신 가격으로
  assert.equal(M.price('claude-opus-9-9').in, 4);
  assert.equal(M.price('gpt-x'), null);
  assert.equal(M.price('<synthetic>'), null);
});

test('rowCostUsesEachRate', () => {
  // opus 5.5: 입력 1M=$4, 출력 1M=$20, 캐시쓰기5m 1M=$5, 1h 1M=$8, 읽기 1M=$0.2
  const r = row('2026-11-17', 'claude-opus-5-5', { in: 1e6, out: 1e6, c5: 1e6, c1: 1e6, cr: 1e6 });
  near(M.rowCost(r), 37.2);
  assert.equal(M.rowCost(row('2026-11-17', 'mystery', { in: 1e6 })), 0);
  assert.equal(M.rowTokens(r), 5e6);
});

test('summarizeTotalsModelsStreak', () => {
  const rows = [
    row('2026-11-15', 'claude-opus-5-5', { out: 1e6 }),          // $20
    row('2026-11-16', 'claude-sonnet-5-5', { in: 3e6 }),         // $6
    row('2026-11-17', 'claude-opus-5-5', { cr: 1e6 }),           // $0.2
    row('2026-11-10', 'claude-haiku-5-5', { in: 1e6 }),          // $0.1
  ];
  const s = M.summarize(rows, '2026-11-17');
  assert.equal(s.total, 6e6);
  near(s.cost, 26.3);
  assert.equal(s.today.tokens, 1e6);
  assert.equal(s.activeDays, 4);
  assert.equal(s.streak, 3);
  assert.deepEqual(s.models.map(m => m.model), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
  assert.equal(s.models[1].tokens, 2e6);
  near(s.models[1].cost, 20.2);
  assert.equal(s.days.get('2026-11-16').tokens, 3e6);
});

test('streakCountsFromYesterdayWhenTodayEmpty', () => {
  const rows = [row('2026-11-15', 'claude-opus-5-5', { in: 1 }), row('2026-11-16', 'claude-opus-5-5', { in: 1 })];
  assert.equal(M.summarize(rows, '2026-11-17').streak, 2);
  assert.equal(M.summarize(rows, '2026-11-19').streak, 0);
  assert.equal(M.summarize([], '2026-11-19').streak, 0);
});

test('heatGridShapeLevelsMonths', () => {
  const days = new Map([['2026-11-17', { tokens: 100 }], ['2026-11-16', { tokens: 10 }], ['2026-11-02', { tokens: 1 }],
    ['2026-10-01', { tokens: 50 }]]);
  const g = M.heatGrid(days, '2026-11-17', 8);       // 2026-11-17 = 화요일
  assert.equal(g.weeks.length, 8);
  g.weeks.forEach(w => assert.equal(w.length, 7));
  const last = g.weeks[7];
  assert.equal(last[0].key, '2026-11-15');           // 일요일 시작
  assert.equal(last[2].key, '2026-11-17');
  assert.equal(last[2].level, 4);
  assert.equal(last[3].future, true);                // 내일부터는 빈칸
  assert.equal(last[1].level > 0, true);
  assert.equal(last[0].level, 0);
  assert.ok(g.months.some(m => m.month === 11));
  // 첫 칸은 8주 전 일요일
  assert.equal(g.weeks[0][0].key, '2026-09-27');
});

test('curveInterpolatesAndClamps', () => {
  const pts = [{ t: 40, p: 0 }, { t: 60, p: 20 }, { t: 80, p: 60 }, { t: 95, p: 100 }];
  assert.equal(M.curveRpm(pts, 30, 1200, 6000), 1200);
  assert.equal(M.curveRpm(pts, 100, 1200, 6000), 6000);
  assert.equal(M.curveRpm(pts, 70, 1200, 6000), 1200 + 0.4 * 4800);
  // 순서가 섞여 있어도 온도 순으로
  assert.equal(M.curveRpm([pts[2], pts[0], pts[3], pts[1]], 50, 1000, 2000), 1100);
  assert.equal(M.curveRpm(pts, null, 1200, 6000), null);
});

test('tempTone', () => {
  assert.equal(M.tempTone(35), 'cool');
  assert.equal(M.tempTone(60), 'mild');
  assert.equal(M.tempTone(78), 'warm');
  assert.equal(M.tempTone(92), 'hot');
  assert.equal(M.tempTone(null), 'none');
});

test('fmtTokensByLanguage', () => {
  assert.equal(M.fmtTokens(5.19e9, 'ko'), '51.9억');
  assert.equal(M.fmtTokens(7.1601e7, 'ko'), '7,160.1만');
  assert.equal(M.fmtTokens(950, 'ko'), '950');
  assert.equal(M.fmtTokens(5.19e9, 'en'), '5.19B');
  assert.equal(M.fmtTokens(7.16e7, 'en'), '71.6M');
  assert.equal(M.fmtTokens(12345, 'en'), '12.3K');
  assert.equal(M.fmtTokens(5.19e9, 'zh'), '51.9亿');
  assert.equal(M.fmtTokens(5.19e9, 'ja'), '51.9億');
});

test('dayKeyLocalPadded', () => {
  assert.equal(M.dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('modelNamePretty', () => {
  assert.equal(M.modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(M.modelName('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(M.modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(M.modelName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(M.modelName('gpt-x'), 'gpt-x');
});
