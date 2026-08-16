// Server-side locale for strings that reach the user: connectivity-test
// reports, model-list labels, error messages and the vision transcription.
//
// The panel owns the authoritative locale (DSH's setting may be absent, in
// which case the browser decides), so it passes `lang` with every request and
// the hub calls setLang(). The host's durable setting seeds the initial value
// for paths with no request behind them, such as the pasted-image pre-step.

let LANG = 'en';

export function setLang(lang) {
  if (lang === 'zh' || lang === 'en') LANG = lang;
  return LANG;
}

export function getLang() { return LANG; }

/** Pick the string for the active locale. Both branches are cheap literals. */
export function tr(zh, en) { return LANG === 'zh' ? zh : en; }
