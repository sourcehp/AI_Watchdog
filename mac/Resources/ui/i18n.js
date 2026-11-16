// 언어 문자열과 .NET 식 서식("{0}", "{0:0.#}", "{1:0.0}")
(function (root) {
  'use strict';
  function makeT(doc, en) {
    const s = (doc && doc.strings) || {}, e = (en && en.strings) || {};
    return key => (key in s ? s[key] : key in e ? e[key] : key);
  }
  function num(v, spec) {
    const [, dec = ''] = spec.split('.');
    const fixed = (dec.match(/0/g) || []).length, opt = (dec.match(/#/g) || []).length;
    let out = Number(v).toFixed(fixed + opt);
    if (opt) out = out.replace(new RegExp(`0{1,${opt}}$`), '').replace(/\.$/, '');
    return out;
  }
  function fmt(str, ...args) {
    return String(str).replace(/\{(\d+)(?::([0#.]+))?\}/g, (m, i, spec) => {
      const v = args[+i];
      if (v === undefined) return m;
      return spec ? num(v, spec) : String(v);
    });
  }
  const api = { makeT, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AWI18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
