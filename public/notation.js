// Typed note entry (format v2: fixed octaves, finger written after the note).
//
//   C D E F G A H     octave 4: C = middle C (C4) up to H4
//   C'  C''           one / two octaves up (C5, C6)
//   C,  C,,           one / two octaves down (C3, C2)
//   Cis Dis … / C# …  black keys (Czech or # names); with English naming B = B natural, Czech B = B flat
//   E3                finger 3; without a digit the finger is guessed from the previous note of that hand (marked ?)
//   R: / P:  L:       right / left hand; a line without a prefix keeps the previous hand
//   C3+E5  E3+L: C5   pressed together (chord), also across hands
//   | -  spaces       ignored (use | for bars)
//
// One line per row of the sheet; "Pause after each line" makes each line a block.

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, H: 11 };
const NAMES = {
  H: ['C', 'Cis', 'D', 'Dis', 'E', 'F', 'Fis', 'G', 'Gis', 'A', 'Ais', 'H'],
  B: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
};
export const KEY_LO = 36, KEY_HI = 96;                  // Casio LK-S250: 61 keys, C2–C7

function pcOf(letter, acc, naming) {
  const L = letter.toUpperCase();
  let pc = L === 'B' ? (naming === 'H' ? 10 : 11) : LETTER[L];
  if (acc === '#' || acc === 'is') pc += 1;
  else if (acc === 'es' || acc === 's') pc -= 1;
  return (pc + 12) % 12;
}
const noteName = (pc, naming) => (NAMES[naming] || NAMES.H)[pc];
const octaveOf = p => Math.floor(p / 12) - 1;           // MIDI 60 = C4
const marks = p => { const d = octaveOf(p) - 4; return d > 0 ? "'".repeat(d) : ','.repeat(-d); };
export const spell = (p, naming) => noteName(p % 12, naming) + marks(p);   // e.g. 49 → "Cis,"

const TOKEN = /(\s+|\||-)|([RrPpLl])\s*:|(\+)|([A-Ha-h])(is|es|s|#)?([',’]*)([1-5])?/y;
function* tokens(str) {
  let i = 0;
  while (i < str.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(str);
    if (!m) { yield { bad: str[i] }; i++; continue; }
    i = TOKEN.lastIndex;
    if (m[1] !== undefined) continue;
    if (m[2]) { yield { hand: /[Ll]/.test(m[2]) ? 'L' : 'R' }; continue; }
    if (m[3]) { yield { plus: true }; continue; }
    const mk = m[6] || '';
    yield {
      letter: m[4], acc: m[5],
      shift: (mk.match(/['’]/g) || []).length - (mk.match(/,/g) || []).length,
      finger: m[7] ? +m[7] : null,
    };
  }
}

// finger guess from the previous note of the same hand, by white-key distance
const whiteIndex = p => Math.floor(p / 12) * 7 + [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][p % 12];
function guessFinger(ref, p, h) {
  if (!ref) return h === 'R' ? 1 : 5;
  const d = whiteIndex(p) - whiteIndex(ref.p);
  return Math.max(1, Math.min(5, h === 'R' ? ref.f + d : ref.f - d));
}

// text → steps [{p, f, h, br?, g?, with?: [{p, f, h, g?}]}]
export function parseExercise(o) {
  const notes = [], warnings = [], prev = {}, out = [];
  let hand = 'R', guesses = 0;
  (o.text || '').split('\n').forEach((line, li) => {
    const start = notes.length;
    let join = false;
    for (const t of tokens(line)) {
      if (t.bad) { warnings.push(`Line ${li + 1}: "${t.bad}" ignored`); continue; }
      if (t.hand) { hand = t.hand; continue; }
      if (t.plus) { join = true; continue; }
      if (!t.letter) continue;
      const p = (5 + t.shift) * 12 + pcOf(t.letter, t.acc, o.naming);
      const key = { p, f: t.finger, h: hand };
      if (!key.f) { key.f = guessFinger(prev[hand], p, hand); key.g = true; guesses++; }
      prev[hand] = key;
      if (p < KEY_LO || p > KEY_HI) out.push(`${noteName(p % 12, o.naming)}${octaveOf(p)}`);
      if (join && notes.length) {
        const s = notes[notes.length - 1];
        if (s.p !== p && !(s.with || []).some(w => w.p === p)) (s.with = s.with || []).push(key);
      } else notes.push(key);
      join = false;
    }
    if (o.lineBlocks && notes.length > start) notes[notes.length - 1].br = true;
  });
  if (guesses) warnings.push(`${guesses} note${guesses === 1 ? ' has' : 's have'} no finger number, so it is guessed (marked ?). Add it after the note, e.g. E3.`);
  if (out.length) warnings.push(`Not on the 61-key keyboard (C2–C7): ${[...new Set(out)].join(', ')}`);
  return { notes, warnings };
}

// items [{keys:[{p,h,f?}], newLine}] → text; fingers written when known
function emit(items, naming) {
  const lines = [];
  let line = null, lineHand = null;
  const tok = k => spell(k.p, naming) + (k.f && !k.g ? k.f : '');
  for (const it of items) {
    const main = line && !it.newLine && it.keys.some(k => k.h === lineHand) ? lineHand
      : it.keys.some(k => k.h === 'R') ? 'R' : it.keys[0].h;            // prefer the right hand (usually the melody)
    if (!line || it.newLine) { line = []; lines.push(line); line.hand = lineHand = main; }
    else if (main !== lineHand) { line.push(`${main}:`); lineHand = main; }
    const keys = [...it.keys.filter(k => k.h === main), ...it.keys.filter(k => k.h !== main)];
    let t = tok(keys[0]);
    for (const w of keys.slice(1)) t += '+' + (w.h !== lineHand ? `${w.h}: ` : '') + tok(w) + (w.h !== lineHand ? ` ${lineHand}:` : '');
    line.push(t);
  }
  // tidy: drop hand switches that are immediately overridden or end a line
  return lines.map(l => `${l.hand}: ${l.join(' ')}`.replace(/(?:[RL]:\s*)+(?=[RL]:)/g, '').replace(/\s*[RL]:\s*$/, '')).join('\n');
}

// saved steps → text (switching from tapped entry, upgrading old texts). One line per block, or per hand run.
export function notesToText(notes, o) {
  const useBr = notes.some(n => n.br);
  return emit(notes.map((n, i) => ({
    keys: [n, ...(n.with || [])],
    newLine: i > 0 && (useBr ? !!notes[i - 1].br : n.h !== notes[i - 1].h),
  })), o.naming);
}

// MIDI steps [{keys:[{p,h}], bar}] → text, one line per `barsPerLine` bars; fingers left for the parser to guess
export function stepsToText(steps, o, barsPerLine = 1) {
  let last = null;
  return emit(steps.map(s => {
    const g = Math.floor((s.bar || 0) / barsPerLine), nl = last !== null && g !== last;
    last = g;
    return { keys: s.keys, newLine: nl };
  }), o.naming);
}
