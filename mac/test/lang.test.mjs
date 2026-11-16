import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const I = createRequire(import.meta.url)('../Resources/ui/i18n.js');
const dir = new URL('../Resources/lang/', import.meta.url);
const load = c => JSON.parse(fs.readFileSync(new URL(c + '.json', dir), 'utf8'));
const codes = ['en', 'ko', 'ja', 'zh', 'es', 'vi', 'th'];
const en = load('en');

test('allKeysPresent', () => {
  for (const c of codes) {
    const d = load(c);
    assert.equal(d.code, c);
    for (const k of Object.keys(en.strings)) assert.ok(k in d.strings, `${c} missing ${k}`);
  }
});

test('noWindowsWords', () => {
  const bad = /Windows|PowerShell|powercfg|트레이|작업 표시줄|taskbar|\btray\b|bandeja|トレイ|タスクバー|托盘|任务栏|khay|ถาด|แถบงาน|hibernat|최대 절전|休止状態|休眠|ngủ đông|ไฮเบอร์เนต|Hibernar/i;
  for (const c of codes) {
    const d = load(c);
    assert.equal(d.font, undefined);
    for (const [k, v] of Object.entries(d.strings)) assert.ok(!bad.test(v), `${c}.${k}: ${v}`);
  }
});

test('koJosaAfterMac', () => {
  const s = Object.values(load('ko').strings).join('\n');
  assert.ok(!/PC/.test(s));
  assert.ok(!/Mac(를|가|는|로)/.test(s));
});

test('fallbackToEnglish', () => {
  const T = I.makeT({ strings: { 'x.cancel': '취소' } }, en);
  assert.equal(T('x.cancel'), '취소');
  assert.equal(T('x.add'), 'Add');
  assert.equal(T('nope.key'), 'nope.key');
});

test('fmtDecimals', () => {
  assert.equal(I.fmt('Working {0:0.#}%', 12.34), 'Working 12.3%');
  assert.equal(I.fmt('{0:0}%', 7.6), '8%');
  assert.equal(I.fmt('{0:0.0} of {1:0} GB', 3.21, 16), '3.2 of 16 GB');
  assert.equal(I.fmt('{0} min {1}s', 2, 5), '2 min 5s');
});
