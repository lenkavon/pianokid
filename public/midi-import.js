// MIDI file → steps for the typing editor. Parser: @tonejs/midi (vendored, MIT), loaded only when needed.
let lib;
function loadLib() {
  return lib ||= new Promise((resolve, reject) => {
    if (self.Midi) return resolve(self.Midi);
    const s = document.createElement('script');
    s.src = 'vendor/tonejs-midi-2.0.28.js';
    s.onload = () => resolve(self.Midi);
    s.onerror = () => { lib = null; reject(new Error('MIDI parser did not load')); };
    document.head.append(s);
  });
}

export async function readMidi(file) {
  const Midi = await loadLib();
  return new Midi(await file.arrayBuffer());
}

// tracks worth offering: has notes, not drums
export function summarize(midi) {
  return midi.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.notes.length && !t.instrument.percussion).map(({ t, i }) => {
    const ps = t.notes.map(n => n.midi);
    return { i, name: (t.name || '').trim() || t.instrument.name || `Track ${i + 1}`, count: ps.length,
             lo: Math.min(...ps), hi: Math.max(...ps), avg: ps.reduce((a, b) => a + b, 0) / ps.length };
  });
}

// two tracks → higher one is the right hand; otherwise split at middle C
export function defaultChoices(tracks) {
  const byAvg = [...tracks].sort((a, b) => b.avg - a.avg);
  return tracks.map(t => ({ i: t.i, on: true,
    hand: tracks.length === 2 ? (t === byAvg[0] ? 'R' : 'L') : 'auto' }));
}

export function midiToSteps(midi, choices, split = 60) {
  const ppq = midi.header.ppq || 480, tol = ppq / 8;  // notes starting within a 32nd count as together
  const notes = [];
  for (const c of choices) {
    if (!c.on) continue;
    for (const n of midi.tracks[c.i].notes)
      notes.push({ p: n.midi, t: n.ticks, h: c.hand === 'auto' ? (n.midi >= split ? 'R' : 'L') : c.hand });
  }
  notes.sort((a, b) => a.t - b.t || a.p - b.p);
  const steps = [];
  let cur = null;
  for (const n of notes) {
    if (!cur || n.t - cur.t > tol) { cur = { t: n.t, keys: [] }; steps.push(cur); }
    if (!cur.keys.some(k => k.p === n.p)) cur.keys.push({ p: n.p, h: n.h });
  }
  const bar = t => { try { return Math.floor(midi.header.ticksToMeasures(t) + 1e-6); } catch (e) { return Math.floor(t / (ppq * 4)); } };
  for (const s of steps) { s.bar = bar(s.t); delete s.t; }
  const bpm = midi.header.tempos?.[0]?.bpm;
  return { steps, bpm: bpm ? Math.round(bpm) : null };
}
