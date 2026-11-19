// Typed note entry.
//
//   Hand positions: five keys, low → high, "-" for a finger that has no key.
//     right hand: fingers 1 2 3 4 5     "C D E F G"        (thumb on C)
//     left hand:  fingers 5 4 3 2 1     "C D E F G"        (thumb on G)
//                                       "- Fis Gis Ais -"  (black keys, fingers 2 3 4)
//   Exercise text, one line per row of the sheet:
//     R: C D E F G          right hand (P: works too)
//     L: G F E D C          left hand; a line without a prefix keeps the previous hand
//     CDEFG                 spaces are optional
//     E3                    a digit sets the finger explicitly
//     C' / C,               one octave up / down from the hand position
//     C+E   R: E+L: C       "+" = pressed together (a chord), also across hands
//     | -                   ignored, use them like bar lines
//
// Fingers come from the hand position. A note outside it is placed nearest to that hand's previous note
// (melodies move stepwise), gets the nearest finger and is flagged.

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, H: 11 };
const NAMES = {
  H: ['C', 'Cis', 'D', 'Dis', 'E', 'F', 'Fis', 'G', 'Gis', 'A', 'Ais', 'H'],
  B: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
};

// Czech naming ('H'): H = B natural, B = B flat. English ('B'): B = B natural (H accepted too).
function pcOf(letter, acc, naming) {
  const L = letter.toUpperCase();
  let pc = L === 'B' ? (naming === 'H' ? 10 : 11) : LETTER[L];
  if (acc === '#' || acc === 'is') pc += 1;
  else if (acc === 'es' || acc === 's') pc -= 1;
  return (pc + 12) % 12;
}
const noteName = (pc, naming) => (NAMES[naming] || NAMES.H)[pc];

// One shared tokenizer for positions and exercise lines (sticky regex, no case-insensitive flag:
// accidentals are lower-case so "CES" stays C, E, S? → the S is reported as unknown)
const TOKEN = /(\s+|\||-)|([RrPpLl])\s*:|(\+)|([A-Ha-h])(is|es|s|#)?([',’]*)([1-5])?/y;
function* tokens(str) {
  let i = 0;
  while (i < str.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(str);
    if (!m) { yield { bad: str[i] }; i++; continue; }
    i = TOKEN.lastIndex;
    if (m[1] !== undefined) { if (m[1] === '-') yield { gap: true }; continue; }
    if (m[2]) { yield { hand: /[Ll]/.test(m[2]) ? 'L' : 'R' }; continue; }
    if (m[3]) { yield { plus: true }; continue; }
    const marks = m[6] || '';
    yield {
      letter: m[4], acc: m[5],
      shift: (marks.match(/['’]/g) || []).length - (marks.match(/,/g) || []).length,
      finger: m[7] ? +m[7] : null,
    };
  }
}

// "C D E F G" + octave → five pitches low → high (null where "-"); each key is the next one up
export function parsePos(str, oct, naming) {
  const keys = [], warnings = [];
  let floor = (oct + 1) * 12 - 1;
  for (const t of tokens(str || '')) {
    if (t.gap) keys.push(null);
    else if (t.letter) {
      const pc = pcOf(t.letter, t.acc, naming);
      let p = floor + 1; while (p % 12 !== pc) p++;
      keys.push(p); floor = p;
    } else if (t.bad) warnings.push(`"${t.bad}" ignored`);
  }
  if (keys.length > 5) warnings.push('only the first 5 keys are used');
  while (keys.length < 5) keys.push(null);
  return { keys: keys.slice(0, 5), warnings };
}

// position keys → [{p, f}] for the given hand
function fingerMap(hand, keys) {
  return keys.map((p, i) => p == null ? null : { p, f: hand === 'R' ? i + 1 : 5 - i }).filter(Boolean);
}

function resolve(pc, shift, finger, map, prev) {
  let hit = map.find(k => k.p % 12 === pc);
  if (finger) { const k = map.find(k => k.f === finger && k.p % 12 === pc); if (k) hit = k; }
  let p, f, g = false;
  if (hit) { p = hit.p; f = hit.f; }
  else {
    const center = prev ?? (map.length ? map.reduce((s, k) => s + k.p, 0) / map.length : 60);
    p = Math.round(center); while (p % 12 !== pc) p++;
    if (p - center > 6) p -= 12;                        // nearest pitch with that name
    const near = map.reduce((b, k) => !b || Math.abs(k.p - p) < Math.abs(b.p - p) ? k : b, null);
    f = near ? near.f : 1; g = true;
  }
  p += 12 * shift;                                      // octave marks keep the finger of the same key in the position
  if (finger) { f = finger; g = false; }
  return { p, f, g };
}

export function maps(o) {
  const R = parsePos(o.posR, o.octR, o.naming), L = parsePos(o.posL, o.octL, o.naming);
  return { R: fingerMap('R', R.keys), L: fingerMap('L', L.keys), warnings: [...R.warnings.map(w => 'Right hand: ' + w), ...L.warnings.map(w => 'Left hand: ' + w)] };
}

// text → steps [{p, f, h, br?, g?, with?: [{p, f, h, g?}]}]
export function parseExercise(o) {
  const m = maps(o), notes = [], warnings = [...m.warnings];
  let hand = 'R', guesses = 0;
  const prev = {};                                      // last pitch per hand
  (o.text || '').split('\n').forEach((line, li) => {
    const start = notes.length;
    let join = false;
    for (const t of tokens(line)) {
      if (t.bad) { warnings.push(`Line ${li + 1}: "${t.bad}" ignored`); continue; }
      if (t.hand) { hand = t.hand; continue; }
      if (t.plus) { join = true; continue; }
      if (!t.letter) continue;
      const k = resolve(pcOf(t.letter, t.acc, o.naming), t.shift, t.finger, m[hand], prev[hand]);
      prev[hand] = k.p;
      const key = { p: k.p, f: k.f, h: hand };
      if (k.g) { key.g = true; guesses++; }
      if (join && notes.length) {
        const s = notes[notes.length - 1];
        if (s.p !== key.p && !(s.with || []).some(w => w.p === key.p)) (s.with = s.with || []).push(key);
      } else notes.push(key);
      join = false;
    }
    if (o.lineBlocks && notes.length > start) notes[notes.length - 1].br = true;
  });
  if (guesses) warnings.push(`${guesses} note${guesses === 1 ? ' is' : 's are'} outside the hand position, so the finger is a guess (marked ?). Add a digit to set it, e.g. E3.`);
  return { notes, warnings };
}

// steps → text that parses back to the same keys and fingers (used when switching from tapped entry)
export function notesToText(notes, o) {
  const m = maps(o), lines = [], prev = {};
  const useBr = notes.some(n => n.br);                  // blocks set → one line per block, else one line per hand run
  let line = null, lineHand = null;
  const tokenFor = key => {                             // same resolution order as parseExercise
    const pc = key.p % 12, r = resolve(pc, 0, null, m[key.h], prev[key.h]);
    const shift = Math.round((key.p - r.p) / 12);
    const back = resolve(pc, shift, null, m[key.h], prev[key.h]);
    prev[key.h] = key.p;
    return noteName(pc, o.naming) + (shift > 0 ? "'".repeat(shift) : ','.repeat(-shift)) + (back.f !== key.f ? key.f : '');
  };
  notes.forEach((s, i) => {
    if (!line) { line = []; lines.push(line); line.hand = lineHand = s.h; }
    else if (s.h !== lineHand) {
      if (useBr) line.push(`${s.h}:`); else { line = []; lines.push(line); line.hand = s.h; }
      lineHand = s.h;
    }
    let tok = tokenFor(s);
    for (const w of s.with || []) tok += '+' + (w.h !== lineHand ? `${w.h}: ` : '') + tokenFor(w) + (w.h !== lineHand ? ` ${lineHand}:` : '');
    line.push(tok);
    if (useBr && s.br && i < notes.length - 1) line = null;
  });
  // tidy: drop hand switches that are immediately overridden or end a line
  return lines.map(l => `${l.hand}: ${l.join(' ')}`.replace(/(?:[RL]:\s*)+(?=[RL]:)/g, '').replace(/\s*[RL]:\s*$/, '')).join('\n');
}
