import { connectCloud } from './cloud.js';
import { parseExercise, notesToText, stepsToText, spell } from './notation.js';
import { readMidi, summarize, defaultChoices, midiToSteps } from './midi-import.js';

// ---------- Notes & colours ----------
const PC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK = new Set([1,3,6,8,10]);
// Boomwhacker-style default; edit in Settings to match the teacher's sheet
const DEFAULT_COLORS = {C:'#E5333F',D:'#F5911E',E:'#F7CF1E',F:'#3BAA4A',G:'#20AFC4',A:'#7B4FC4',B:'#E2468C'};
// left hand green → yellow, right hand blue → red (thumb first), so a colour also tells the hand
const DEFAULT_FINGER = {L:{1:'#1B7F3A',2:'#3FA34D',3:'#7DBE3C',4:'#BCCB2A',5:'#F2C200'},
                        R:{1:'#1F5FD6',2:'#6A4FD3',3:'#A33FB6',4:'#D63A7E',5:'#E5333F'}};
const fingerDefaults = () => ({L:{...DEFAULT_FINGER.L}, R:{...DEFAULT_FINGER.R}});
// style 'notes' = colour by note; 'fingers' = sheet is coloured finger numbers → colour by finger, big circle shows the finger
const DEFAULT_BLACK = {'C#':'#8E1B24','D#':'#A85A0C','F#':'#1F6B2A','G#':'#0D6577','A#':'#4B2A85'};
let settings = {v:3, naming:'H', style:'fingers', appSound:false, colors:{...DEFAULT_COLORS}, blackColors:{...DEFAULT_BLACK}, fingerColors:fingerDefaults()}; // Czech naming: B natural is called H
// black keys: darker shade of the white key below by default; set them to match the stickers / sheet
// v2: colour by finger is the default; v3: finger colours per hand. Older saved settings are upgraded once
const mergeSettings = s => ({...settings, ...s, ...((s.v || 1) < 2 ? {style:'fingers'} : {}), v:3, colors:{...DEFAULT_COLORS, ...(s.colors||{})}, blackColors:{...DEFAULT_BLACK, ...(s.blackColors||{})}, fingerColors: (s.v || 1) < 3 || !s.fingerColors?.L ? fingerDefaults() : {L:{...DEFAULT_FINGER.L, ...s.fingerColors.L}, R:{...DEFAULT_FINGER.R, ...s.fingerColors.R}}});

const CZ = {'B':'H','C#':'Cis','D#':'Dis','F#':'Fis','G#':'Gis','A#':'Ais'};   // Czech names
const name = p => { const n = PC[p%12]; return settings.naming === 'H' ? (CZ[n] || n) : n; };
const octave = p => Math.floor(p/12) - 1;              // MIDI 60 = C4 (middle C)
const color = p => (BLACK.has(p%12) ? settings.blackColors : settings.colors)[PC[p%12]];
const fColor = (h, f) => settings.fingerColors[h === 'L' ? 'L' : 'R'][f];
const nColor = n => settings.style === 'fingers' ? fColor(n.h, n.f) : color(n.p);
const keysOf = n => [n, ...(n.with || [])];          // a step can be a chord: n.with = more keys pressed together
const nLabel = n => settings.style === 'fingers' ? n.f : name(n.p);
const whiteIndex = p => Math.floor(p/12)*7 + [0,0,1,1,2,3,3,4,4,5,5,6][p%12];
// white-key index → MIDI pitch, and "n white keys up/down"
const whiteToPitch = w => Math.floor(w/7)*12 + [0,2,4,5,7,9,11][((w%7)+7)%7];
const whiteStep = (p, d) => whiteToPitch(whiteIndex(p) + d);
// five-finger position: right hand fingers go up from the thumb, left hand fingers go down from the thumb
const fingerPitch = (h, f, thumb) => whiteStep(thumb, h === 'R' ? f-1 : -(f-1));
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const pick = (o, ks) => Object.fromEntries(ks.filter(k => o[k] != null).map(k => [k, o[k]]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function ink(hex){ const n=parseInt(hex.slice(1),16); const r=n>>16&255,g=n>>8&255,b=n&255;
  return (0.299*r+0.587*g+0.114*b) > 160 ? '#1F2B33' : '#FFFFFF'; }

// ---------- Storage ----------
// Firestore when hosted on Firebase and signed in; browser storage otherwise (local dev).
let backend = null, cloud = null, loadFailed = false, noAccess = false;
const store = {
  async get(k){ try{
      if (backend) return await backend.get(k);
      const v = localStorage.getItem(k); return v ? JSON.parse(v) : null;
    }catch(e){ console.error(e); return null; } },
  async set(k,v){ try{
      // Firestore: don't await. Offline, the write is queued in the local cache and the promise only settles once online.
      if (backend){ backend.set(k, v).catch(e => { console.error(e); toast('Could not sync. Check the connection.'); }); return true; }
      localStorage.setItem(k, JSON.stringify(v)); return true;
    }catch(e){ console.error(e); return false; } },
  async del(k){ try{
      if (backend) backend.del(k).catch(e => console.error(e)); else localStorage.removeItem(k);
    }catch(e){} }
};

// ---------- State ----------
let exercises = [];          // {id, name, icon, notes:[{p,f,h,br}], bpm, thumbR, thumbL, best}
const ICONS = ['🎵','🐝','🐞','🦋','🐸','🐱','🐶','🐻','🦊','🐰','🐢','🐟','🦄','🐉','🌈','⭐','🌙','☀️','🌸','🍎','🍓','🎈','🚂','🚀','🏰','🎄','⛄','🎃','🐣','🦆'];
let view = 'home';
let edit = null;             // {id, name, icon, notes, sel, oct, isNew, thumbR, thumbL, bpm}
let play = null;             // {ex, i, first, clean, misses, log, stars}

async function saveList(){
  if (loadFailed){ toast('Lessons did not load, so saving is off. Reload when online.'); return; } // never overwrite cloud data with an empty list
  if (!await store.set('exercises', exercises)) toast('Could not save. Storage may be full.');
}

// ---------- MIDI ----------
let midiState = 'idle', midiName = '', midiAccess = null;
const held = new Set();            // keys currently held down on the Casio
async function initMidi(){
  if (!navigator.requestMIDIAccess){ midiState = 'unsupported'; renderBar(); return; }
  try{
    midiAccess = await navigator.requestMIDIAccess();   // no sysex needed: note-on is enough
    midiAccess.onstatechange = bindInputs;               // replug the cable without reloading
    bindInputs();
  }catch(e){ midiState = 'denied'; renderBar(); }
}
function bindInputs(){
  const names = [];
  for (const inp of midiAccess.inputs.values()){
    inp.onmidimessage = onMidi;
    if (inp.state === 'connected') names.push(inp.name);
  }
  midiState = names.length ? 'ok' : 'none'; midiName = names[0] || '';
  renderBar();
}
function onMidi(e){
  const [st, note, vel] = e.data;
  const cmd = st & 0xF0;
  if (cmd === 0x90 && vel > 0){ held.add(note); handleNote(note, 'midi'); }          // note-on
  else if (cmd === 0x80 || cmd === 0x90) held.delete(note);                          // note-off (or note-on with velocity 0)
}

// Sound from the phone. appSound = Casio volume at 0 and only correct notes are heard ("silent mistakes")
let ac;
function audio(){ if (!ac) ac = new AudioContext({latencyHint:'interactive'}); if (ac.state === 'suspended') ac.resume(); return ac; }
document.addEventListener('click', () => { try{ audio(); }catch(e){} }, true); // unlock on first tap (e.g. the Play button)
function blip(p){ try{
  const a = audio(), t = a.currentTime, fq = 440*Math.pow(2,(p-69)/12);
  const g = a.createGain(); g.connect(a.destination);
  g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.35,t+0.008); g.gain.exponentialRampToValueAtTime(0.0001,t+1.2);
  for (const [type, mul, vol] of [['triangle',1,1],['sine',2,0.3]]){ // simple piano-ish tone: fundamental + soft octave
    const o = a.createOscillator(), og = a.createGain(); o.type = type; o.frequency.value = fq*mul; og.gain.value = vol;
    o.connect(og).connect(g); o.start(t); o.stop(t+1.25);
  }
}catch(e){} }

function handleNote(p, src){
  stopPlayback();
  if (view === 'edit'){ if (src === 'screen' || settings.appSound) blip(p); if (edit.mode === 'text') typeNote(p); else addNote(p); }
  else if (view === 'play') playNote(p, src);
  else if (src === 'screen') blip(p);
  const k = document.querySelector(`.key[data-p="${p}"]`);
  if (k){ k.classList.add('down'); setTimeout(() => k.classList.remove('down'), 150); }
}

// ---------- Editor ----------
const TEXT_DEFAULTS = {lineBlocks:false};
function newExercise(){
  edit = {id:uid(), name:'', notes:[], icon:'🎵', sel:-1, oct:4, isNew:true, thumbR:60, thumbL:55, bpm:80,
          mode:'text', text:'', warnings:[], ...TEXT_DEFAULTS};
  view = 'edit'; render();
}
async function openEdit(id){
  const ex = exercises.find(x => x.id === id);
  const lowest = Math.min(...ex.notes.map(n => n.p));
  edit = {id, name:ex.name, notes:ex.notes.map(n => ({...n})), icon: ex.icon || '🎵',
          sel: ex.notes.length-1, oct: clamp(octave(lowest),1,6), isNew:false, thumbR: ex.thumbR || 60, thumbL: ex.thumbL || 55, bpm: ex.bpm || 80,
          ...TEXT_DEFAULTS, ...pick(ex, ['lineBlocks']), mode: ex.text != null ? 'text' : 'keys', text: ex.text || '', warnings:[]};
  if (edit.mode === 'text' && ex.textV !== 2){      // old texts counted octaves from hand positions: rewrite from the saved notes
    edit.lineBlocks = edit.lineBlocks || edit.notes.some(n => n.br);
    edit.text = notesToText(edit.notes, textOpts());
  }
  if (edit.mode === 'text') reparse();
  view = 'edit'; render();
}
function addNote(p){
  // Insert after the selected chip, so you can fix a missed note mid-sequence
  const prev = edit.notes[edit.sel];
  let h = 'R', f = 1;
  if (prev){ // finger guess: move by white-key steps from the previous note (you correct it if wrong)
    h = prev.h; const d = whiteIndex(p) - whiteIndex(prev.p);
    f = clamp(h === 'R' ? prev.f + d : prev.f - d, 1, 5);
  }
  insertNote(p, f, h);
}
function typeNote(p){                       // Casio key in typing mode → note name at the cursor
  const ta = document.getElementById('extext'), word = spell(p, settings.naming);
  if (ta && document.activeElement === ta){
    const a = ta.selectionStart, pre = ta.value.slice(0, a), post = ta.value.slice(ta.selectionEnd);
    const ins = (pre && !/\s$/.test(pre) ? ' ' : '') + word + ' ';
    ta.value = pre + ins + post; ta.selectionStart = ta.selectionEnd = a + ins.length;
  } else if (ta) ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + word + ' ';
  else return;
  edit.text = ta.value; reparse(); refreshDerived();
}
function insertNote(p, f, h){ edit.notes.splice(edit.sel+1, 0, {p, f, h}); edit.sel++; render(); }
async function saveEdit(){
  if (!edit.notes.length){ toast('Add at least one note'); return; }
  let ex = exercises.find(x => x.id === edit.id);
  if (!ex){ ex = {id:edit.id, best:0}; exercises.unshift(ex); }
  ex.name = edit.name.trim() || ('Exercise ' + exercises.length);
  ex.notes = edit.notes.map(n => { const {g, ...k} = n; if (k.with) k.with = k.with.map(({g, ...w}) => w); return k; });   // drop "guessed" flags
  ex.thumbR = edit.thumbR; ex.thumbL = edit.thumbL; ex.bpm = edit.bpm;
  ex.lineBlocks = edit.lineBlocks; ['posR','octR','posL','octL'].forEach(k => delete ex[k]);
  if (edit.mode === 'text'){ ex.text = edit.text; ex.textV = 2; } else { delete ex.text; delete ex.textV; }     // tapped edits: the text would be stale
  ex.icon = edit.icon;
  if (ex.hasPhoto){ delete ex.hasPhoto; await store.del('photo:'+ex.id); }   // drop photos from older versions
  await saveList(); edit = null; view = 'home'; render();
}

// ---------- Playback: Listen (at tempo) and replay (her real timing) ----------
let playback = null;
function stopPlayback(){ if (!playback) return; clearTimeout(playback.timer); playback = null;
  document.querySelectorAll('.chip.hear').forEach(c => c.classList.remove('hear')); }
function sound(p){
  // Keyboard sound mode + Casio connected → the Casio plays it; otherwise the phone does
  const outs = midiAccess ? [...midiAccess.outputs.values()].filter(o => o.state === 'connected') : [];
  if (!settings.appSound && outs.length){ for (const o of outs){ o.send([0x90, p, 90]); o.send([0x80, p, 0], performance.now() + 450); } }
  else blip(p);
}
function flash(p){ const k = document.querySelector(`.key[data-p="${p}"]`); if (k){ k.classList.add('down'); setTimeout(() => k.classList.remove('down'), 250); } }
function runSeq(seq, onStep){            // seq: [{ps, wait}], ps = keys sounded together, wait = ms after the previous step
  stopPlayback(); let i = 0;
  const tick = () => {
    if (!playback) return;
    if (i >= seq.length){ stopPlayback(); return; }
    for (const p of seq[i].ps){ sound(p); flash(p); } onStep && onStep(i); i++;
    if (i < seq.length) playback.timer = setTimeout(tick, seq[i].wait); else playback.timer = setTimeout(tick, 400);
  };
  playback = {timer: setTimeout(tick, 150)};
}
const listen = (notes, bpm, onStep) => runSeq(notes.map(n => ({ps:keysOf(n).map(k => k.p), wait:60000/bpm})), onStep);  // one step per beat
const hearChip = i => document.querySelectorAll('.chip').forEach((c, j) => c.classList.toggle('hear', j === i));

// ---------- Blocks ----------
function blocksOf(ex){                      // → [[start, end), ...]; no breaks set = whole piece in one go
  const N = ex.notes.length, out = [];
  let a = 0;
  for (let i = 0; i < N; i++){
    const end = i === N-1 || !!ex.notes[i].br;
    if (end){ out.push([a, i+1]); a = i+1; }
  }
  return out;
}
const blockIndex = (blocks, i) => blocks.findIndex(([a, b]) => i >= a && i < b);
function splitByHand(notes){                 // one block per run of the same hand
  notes.forEach((n, i) => { n.br = !!notes[i+1] && notes[i+1].h !== n.h; });
}

// ---------- Practice (wait mode) ----------
let wake = null;
async function keepAwake(){ try{ wake = await navigator.wakeLock?.request('screen'); }catch(e){} }
function releaseWake(){ try{ wake?.release(); }catch(e){} wake = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && view === 'play') keepAwake(); });

// practice one hand: keep only that hand's keys; steps with none are dropped (their block end moves back)
function filterHand(notes, h){
  const out = [], clean = k => ({p:k.p, f:k.f, h:k.h});
  for (const n of notes){
    const ks = keysOf(n).filter(k => k.h === h).map(clean);
    if (!ks.length){ if (n.br && out.length) out[out.length-1].br = true; continue; }
    const [m, ...w] = ks;
    out.push({...m, ...(w.length ? {with:w} : {}), ...(n.br ? {br:true} : {})});
  }
  return out;
}
const handsOf = ex => new Set(ex.notes.flatMap(n => keysOf(n).map(k => k.h)));
async function startPlay(id, hand){
  const src = exercises.find(x => x.id === id);
  if (!handsOf(src).has('L') || !handsOf(src).has('R')) hand = 'B';      // one-hand exercise: nothing to choose
  hand = hand || src.practiceHand || 'B';
  const ex = hand === 'B' ? src : {...src, notes: filterHand(src.notes, hand)};
  play = {ex, src, hand, i:0, first:true, clean:0, misses:0, log:[], got:{}};
  view = 'play'; keepAwake(); render();
}
function playNote(p, src){
  if (play.stepDone){ play.stepDone = false; render(); return; }   // any key = open the next step
  const t = play.ex.notes[play.i]; if (!t) return;
  const req = keysOf(t).map(k => k.p), now = performance.now(), ok = req.includes(p);
  play.log.push({p, t: now, ok});
  if (ok){
    if (settings.appSound || src === 'screen') blip(p);
    // chord: every key held down, or pressed within the last 1.5 s (on-screen taps can't be held)
    play.got[p] = now;
    if (!req.every(q => held.has(q) || now - (play.got[q] ?? -1e9) <= 1500)){ render(); return; }
    play.got = {};
    if (play.first) play.clean++;          // score = notes right on the first try
    play.i++; play.first = true;
    if (play.i >= play.ex.notes.length){ finish(); return; }
    if (blocksOf(play.ex).some(([, b]) => b === play.i)){ play.stepDone = true; render(); return; }  // pause like finishing a Lego bag
    render(); burst();
  } else {
    if (!settings.appSound && src === 'screen') blip(p);
    play.first = false; play.misses++;     // with appSound: silent; never a buzzer or red X
  }
}
async function finish(){
  const r = play.clean / play.ex.notes.length;
  play.stars = r >= 0.9 ? 3 : r >= 0.7 ? 2 : 1; // finishing always earns at least 1 star
  const key = {B:'best', L:'bestL', R:'bestR'}[play.hand];             // stars kept per hand choice
  if (play.stars > (play.src[key]||0)){ play.src[key] = play.stars; saveList(); }
  releaseWake(); view = 'done'; render();
}
function burst(){
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const w = document.querySelector('.bubble-wrap'); if (!w) return;
  for (let k = 0; k < 8; k++){
    const s = document.createElement('span'), a = k/8*Math.PI*2;
    s.className = 'spark'; s.textContent = '★';
    s.style.setProperty('--x', Math.cos(a)*120 + 'px'); s.style.setProperty('--y', Math.sin(a)*120 + 'px');
    w.appendChild(s); setTimeout(() => s.remove(), 700);
  }
}

// ---------- Backup ----------
async function exportAll(){
  const blob = new Blob([JSON.stringify({v:2, settings, exercises})], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'piano-steps-backup.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importAll(file){
  try{
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.exercises)) throw new Error('bad file');
    let added = 0;
    for (const ex of d.exercises){
      if (exercises.some(x => x.id === ex.id)) continue;
      delete ex.hasPhoto; exercises.push(ex); added++;
    }
    if (d.settings) settings = mergeSettings(d.settings);
    await store.set('settings', settings); await saveList();
    toast(`Restored ${added} exercise${added === 1 ? '' : 's'}`); render();
  }catch(e){ toast('That file is not a Piano steps backup'); }
}

// ---------- Rendering ----------
function keyAttrs(p, targets, extra=''){
  const t = targets.has(p), c = targets.get(p);
  return `class="key ${BLACK.has(p%12) ? 'black' : 'white'}${t ? ' target' : ''}" data-p="${p}" `
       + `style="--kc:${settings.style === 'notes' ? color(p) : 'transparent'};${t ? `--c:${c};--ci:${ink(c)};` : ''}${extra}" aria-label="${name(p)}${octave(p)}"`;
}
function keyboardHTML(lo, hi, targets = new Map(), labels){
  const whites = []; for (let p = lo; p <= hi; p++) if (!BLACK.has(p%12)) whites.push(p);
  const W = 100/whites.length, w0 = whiteIndex(lo);
  let h = `<div class="kbd" style="min-width:${whites.length*32}px"><div class="whites">`;
  for (const p of whites)
    h += `<button ${keyAttrs(p,targets)}>${p === 60 ? '<i class="mc"></i>' : ''}<span>${labels || targets.has(p) ? name(p) : ''}</span></button>`;
  h += '</div>';
  for (let p = lo; p <= hi; p++) if (BLACK.has(p%12)){
    const left = (whiteIndex(p) - w0 + 1)*W - W*0.3;   // centred on the line between two white keys
    h += `<button ${keyAttrs(p, targets, `left:${left}%;width:${W*0.6}%;`)}>${labels || targets.has(p) ? name(p) : ''}</button>`;
  }
  return h + '</div>';
}
function handSVG(h, fmap){
  // Back of the hand, fingers up. Right hand: thumb on the left. Left hand = mirror.
  const fill = i => fmap[i] || '#FFFFFF', sw = i => fmap[i] ? 5 : 3;
  const fing = (i, x, y, w, ht, tr='') => `<rect x="${x}" y="${y}" width="${w}" height="${ht}" rx="${w/2}" ${tr} fill="${fill(i)}" stroke="#1F2B33" stroke-width="${sw(i)}"/>`;
  const g = fing(2,38,28,16,58) + fing(3,56,14,16,72) + fing(4,74,22,16,64) + fing(5,92,42,14,46)
          + fing(1,22,66,16,50,'transform="rotate(-35 30 114)"')
          + `<rect x="34" y="74" width="72" height="58" rx="22" fill="#FFFFFF" stroke="#1F2B33" stroke-width="3"/>`;
  return `<svg viewBox="0 0 120 140" aria-hidden="true">${h === 'L' ? `<g transform="translate(120 0) scale(-1 1)">${g}</g>` : g}</svg>`;
}
const starsHTML = n => `<span class="stars">${[1,2,3].map(k => `<span class="${k <= n ? '' : 'off'}">★</span>`).join('')}</span>`;

function homeHTML(){
  let h = `<div class="row spread"><h1>Exercises</h1><button class="btn primary" data-act="new">Add exercise</button></div>`;
  if (!exercises.length) h += `<div class="empty">No exercises yet. Add one from the teacher's sheet: pick an icon, enter the notes, and set a finger for each.</div>`;
  for (const ex of exercises) h += `<div class="card"><span class="ico" aria-hidden="true">${ex.icon || '🎵'}</span><div class="info"><h2>${esc(ex.name)}</h2>
      <div class="dots">${ex.notes.slice(0,16).map(n => `<i class="dot" style="background:${nColor(n)}"></i>`).join('')}</div>
      <span class="muted">${ex.notes.length} notes${ex.practiceHand && ex.practiceHand !== 'B' && handsOf(ex).size > 1 ? `, practicing ${ex.practiceHand === 'L' ? 'left' : 'right'} hand` : ''}</span>${starsHTML(ex.best||0)}</div>
      <button class="btn quiet" data-act="edit" data-id="${ex.id}">Edit</button>
      <button class="btn primary big" data-act="play" data-id="${ex.id}">Play</button></div>`;
  return h + `<div class="row" style="margin-top:8px"><button class="btn quiet" data-act="settings">Sound, colors, backup</button></div>`;
}
function chipHTML(n, i){
  const cs = keysOf(n).map(k => `<span class="c" style="background:${nColor(k)};color:${ink(nColor(k))}">${settings.style === 'fingers' ? k.f : name(k.p)}</span>`).join('');
  const sub = keysOf(n).map(k => `${settings.style === 'fingers' ? name(k.p) : k.h + k.f}${k.g ? '?' : ''}`).join('+');
  const guess = keysOf(n).some(k => k.g);
  return `<button class="chip${i === edit.sel && edit.mode === 'keys' ? ' sel' : ''}${n.br && i < edit.notes.length-1 ? ' br' : ''}${guess ? ' guess' : ''}${n.with ? ' chord' : ''}" data-act="sel" data-i="${i}"><span class="cs">${cs}</span><small>${sub}</small></button>`;
}
function stripHTML(){
  return `<div class="strip">${edit.notes.map(chipHTML).join('') || '<span class="muted" style="align-self:center">No notes yet</span>'}</div>`;
}
// parts of the text editor that change while typing (re-rendered without touching the textarea)
function derivedHTML(){
  const w = edit.warnings || [];
  return stripHTML() + (w.length ? `<ul class="warn">${w.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '')
    + `<p class="muted">${edit.notes.length} steps${blocksOf(edit).length > 1 ? `, blocks ${blocksOf(edit).map(([a,b]) => b-a).join(' + ')}` : ''}</p>`;
}
const textOpts = () => ({lineBlocks:edit.lineBlocks, naming:settings.naming});
function reparse(){
  const r = parseExercise({...textOpts(), text:edit.text});
  edit.notes = r.notes; edit.warnings = r.warnings; edit.sel = edit.notes.length-1;
}
function refreshDerived(){ const d = document.getElementById('derived'); if (d) d.innerHTML = derivedHTML(); }

function textEditorHTML(){
  return `<div class="row spread" style="margin-top:14px"><label class="field" for="extext" style="margin:0">Notes, one line per row of the sheet</label>
      <span class="btn quiet file">Import MIDI file<input id="midi-in" type="file" accept=".mid,.midi,audio/midi,audio/x-midi"></span></div>
    <textarea id="extext" rows="7" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="R: C1 D2 E3 F4 G5&#10;L: C,5 D,4 E,3 F,2 G,1">${esc(edit.text)}</textarea>
    <p class="hint"><code>C</code> is middle C (C4), up to <code>H</code>. <code>C'</code> one octave up, <code>C,</code> one octave down, <code>C,,</code> two down.
      Finger after the note: <code>E3</code>. <code>R:</code> or <code>P:</code> right hand, <code>L:</code> left (a line without it keeps the hand).
      <code>C1+E3</code> pressed together, also across hands: <code>E3+L: C,5</code>. <code>|</code> and spaces are ignored.
      Playing the Casio adds notes here too.</p>
    <label class="check"><input type="checkbox" id="lineblocks"${edit.lineBlocks ? ' checked' : ''}> Pause after each line</label>
    <div id="derived">${derivedHTML()}</div>`;
}

function keysEditorHTML(){
  const lo = (edit.oct+1)*12, hi = lo+23, sel = edit.notes[edit.sel];
  let h = `<span class="field">Play the notes on the keyboard in order, or tap the keys below. New notes go after the selected one.</span>
    ${stripHTML()}`;
  if (sel) h += `<div class="row controls"><b>${name(sel.p)}${octave(sel.p)}</b>
      <div class="seg">${['L','R'].map(v => `<button class="${sel.h === v ? 'on' : ''}" data-act="hand" data-v="${v}">${v === 'L' ? 'Left' : 'Right'}</button>`).join('')}</div>
      <div class="seg" aria-label="Finger">${[1,2,3,4,5].map(v => `<button class="${sel.f === v ? 'on' : ''}" data-act="finger" data-v="${v}">${v}</button>`).join('')}</div>
      <button class="btn${sel.br ? ' primary' : ' quiet'}" data-act="br">${sel.br ? 'Block ends here ✓' : 'End block here'}</button>
      <button class="btn danger" data-act="del-note">Delete note</button></div>`;
  if (edit.notes.length) h += `<div class="row" style="margin-top:8px"><span class="muted">${blocksOf(edit).length > 1 ? `Blocks: ${blocksOf(edit).map(([a,b]) => b-a).join(' + ')} notes` : 'No blocks: whole piece in one go'}</span>
      <button class="btn quiet" data-act="split-hand">Split by hand</button><button class="btn quiet" data-act="clear-br">No blocks</button></div>`;
  const fb = (hd, f) => `<button data-act="addf" data-h="${hd}" data-v="${f}" style="box-shadow:inset 0 -6px 0 ${fColor(hd, f)}">${f}</button>`;
  const thumb = hd => `<div class="row"><span class="muted">${hd === 'L' ? 'Left' : 'Right'} thumb on</span><div class="seg">
      <button data-act="thumb" data-h="${hd}" data-v="-1" aria-label="Move down">◀</button><b>${name(edit['thumb'+hd])}${octave(edit['thumb'+hd])}</b>
      <button data-act="thumb" data-h="${hd}" data-v="1" aria-label="Move up">▶</button></div></div>`;
  h += `<span class="field">Add by finger number</span>
    <div class="row"><div class="seg"><b>Left</b>${[5,4,3,2,1].map(f => fb('L',f)).join('')}</div>
      <div class="seg"><b>Right</b>${[1,2,3,4,5].map(f => fb('R',f)).join('')}</div></div>
    <div class="row" style="margin-top:8px">${thumb('L')}${thumb('R')}</div>
    <div class="row spread oct"><button class="btn quiet" data-act="oct" data-v="-1" aria-label="Lower octave">◀</button>
      <span class="muted">${name(lo)}${octave(lo)} to ${name(hi)}${octave(hi)}</span>
      <button class="btn quiet" data-act="oct" data-v="1" aria-label="Higher octave">▶</button></div>
    <div class="kwrap">${keyboardHTML(lo, hi, new Map(), true)}</div>`;
  return h;
}

function editHTML(){
  let h = `<div class="row spread"><button class="btn quiet" data-act="home">Cancel</button><b>${edit.isNew ? 'New exercise' : 'Edit exercise'}</b><button class="btn primary" data-act="save">Save</button></div>
    <label class="field" for="exname">Name</label>
    <input id="exname" type="text" value="${esc(edit.name)}" placeholder="Lesson 3, Little bee" autocomplete="off">
    <span class="field">Icon</span>
    <div class="icons">${(ICONS.includes(edit.icon) ? ICONS : [edit.icon, ...ICONS]).map(e => `<button class="${e === edit.icon ? 'on' : ''}" data-act="icon" data-v="${e}" aria-label="${e}">${e}</button>`).join('')}
      <button class="more" data-act="emoji-picker">All emoji…</button></div>
    <span class="field">Tempo</span>
    <div class="row"><div class="seg"><button data-act="bpm" data-v="-10" aria-label="Slower">−</button><b>${edit.bpm} bpm</b><button data-act="bpm" data-v="10" aria-label="Faster">+</button></div>
      <button class="btn" data-act="listen-edit">▶ Listen</button></div>
    <span class="field">Enter notes by</span>
    <div class="seg">${[['text','Typing'],['keys','Tapping keys']].map(([k,l]) => `<button class="${edit.mode === k ? 'on' : ''}" data-act="mode" data-v="${k}">${l}</button>`).join('')}</div>
    ${edit.mode === 'text' ? textEditorHTML() : keysEditorHTML()}`;
  if (!edit.isNew) h += `<div class="row" style="margin-top:20px"><button class="btn danger" data-act="del-ex">Delete exercise</button></div>`;
  return h;
}
function wallHTML(ex, done, fresh){
  // one brick per note; a row per step; dashed bricks = the plan still to build
  const brick = i => i < done ? `<i class="brick${fresh && i === done-1 ? ' new' : ''}" style="--b:${nColor(ex.notes[i])}"></i>` : '<i class="brick ghost"></i>';
  return `<div class="wall" aria-label="${done} of ${ex.notes.length} bricks">${blocksOf(ex).map(([a, b]) =>
    `<div class="wrow">${Array.from({length: b-a}, (_, k) => brick(a+k)).join('')}</div>`).join('')}</div>`;
}
function playHTML(){
  const ex = play.ex, N = ex.notes.length, blocks = blocksOf(ex), steps = blocks.length;
  const both = handsOf(play.src).size > 1;
  const handSeg = both ? `<div class="seg" aria-label="Hands">${[['L','Left'],['B','Both'],['R','Right']].map(([k,l]) => `<button class="${play.hand === k ? 'on' : ''}" data-act="play-hand" data-v="${k}">${l}</button>`).join('')}</div>` : '';
  const head = label => `<div class="row"><button class="btn quiet" data-act="home">Stop</button><button class="btn quiet" data-act="listen-play" aria-label="Listen">▶ Listen</button>${handSeg}
      <div class="progress"><i style="width:${play.i/N*100}%"></i></div><b>${label}</b></div>`;
  if (play.stepDone){
    const s = blocks.findIndex(([, b]) => b === play.i) + 1;
    return `<section class="play">${head(`Step ${s} of ${steps}`)}
      <div class="stepdone">${wallHTML(ex, play.i, true)}<h1>Step ${s} done!</h1>
        <button class="btn primary big" data-act="next-step">Next step</button><p class="muted">or press any key</p></div></section>`;
  }
  const n = ex.notes[play.i], next = ex.notes[play.i+1], keys = keysOf(n);
  const k = blockIndex(blocks, play.i), stepNo = k + 1, stepEnd = blocks[k][1];
  const ps = ex.notes.flatMap(x => keysOf(x).map(y => y.p)), lo = Math.floor(Math.min(...ps)/12)*12, hi = Math.floor(Math.max(...ps)/12)*12 + 11;
  const mini = x => keysOf(x).map(y => `<span class="mini" style="background:${nColor(y)};color:${ink(nColor(y))}">${nLabel(y)}</span>`).join('');
  const then = play.i+1 === N ? 'last one!' : play.i+1 === stepEnd ? 'last in this step' : `then ${mini(next)}`;
  const bubble = y => `<div class="bubble${keys.length > 1 ? ' small' : ''}${String(nLabel(y)).length > 2 ? ' long' : ''}${play.got[y.p] ? ' got' : ''}" style="background:${nColor(y)};color:${ink(nColor(y))}">${nLabel(y)}</div>`;
  const hands = ['L','R'].filter(h => keys.some(y => y.h === h)).map(h => {
    const ks = keys.filter(y => y.h === h), fmap = Object.fromEntries(ks.map(y => [y.f, nColor(y)]));
    return `<div class="hand">${handSVG(h, fmap)}<div class="finger">${ks.map(y => y.f).join(' ')}</div><div class="muted">${h === 'L' ? 'Left hand' : 'Right hand'}</div></div>`;
  }).join('');
  const targets = new Map(keys.map(y => [y.p, nColor(y)]));
  return `<section class="play">${head(steps > 1 ? `Step ${stepNo} of ${steps}` : `${play.i+1}/${N}`)}
    <div class="stage">
      <div class="ico-big" aria-hidden="true">${ex.icon || '🎵'}</div>
      <div class="bubble-wrap"><div class="bubbles">${keys.map(bubble).join('')}</div>${keys.length > 1 ? '<div class="muted">together</div>' : ''}<div class="then">${then}</div></div>
      ${hands}
      ${wallHTML(ex, play.i, play.i > 0)}
    </div>
    <div class="kwrap">${keyboardHTML(lo, hi, targets, false)}</div></section>`;
}
function doneHTML(){
  return `<section class="done"><div class="ico-big" aria-hidden="true">${play.ex.icon || '🎵'}</div>${wallHTML(play.ex, play.ex.notes.length, false)}<div class="bigstars">${[1,2,3].map(k => `<span class="${k <= play.stars ? '' : 'off'}">★</span>`).join('')}</div>
    <h1>Well done!</h1>${play.hand !== 'B' ? `<p class="muted">${play.hand === 'L' ? 'Left' : 'Right'} hand only</p>` : ''}<p class="muted">${play.clean} of ${play.ex.notes.length} notes right on the first try</p>
    <div class="row center"><button class="btn" data-act="replay">▶ Hear how I played</button><button class="btn primary" data-act="again">Play again</button><button class="btn" data-act="home">All exercises</button></div></section>`;
}
function settingsHTML(){
  return `<div class="row spread"><button class="btn quiet" data-act="home">Back</button><b>Settings</b><span></span></div>
    <span class="field">Note names</span>
    <div class="seg">${['H','B'].map(v => `<button class="${settings.naming === v ? 'on' : ''}" data-act="naming" data-v="${v}">C D E F G A ${v}</button>`).join('')}</div>
    <span class="field">Sound</span>
    <div class="seg">${[[false,'Keyboard'],[true,'Phone, correct notes only']].map(([k,l]) => `<button class="${settings.appSound === k ? 'on' : ''}" data-act="sound" data-v="${k}">${l}</button>`).join('')}</div>
    <p class="muted" style="margin:6px 0 0">With Phone, turn the Casio's volume to 0, so wrong keys make no sound.</p>
    <span class="field">The teacher's sheet shows</span>
    <div class="seg">${[['notes','Colored notes'],['fingers','Colored finger numbers']].map(([k,l]) => `<button class="${settings.style === k ? 'on' : ''}" data-act="style" data-v="${k}">${l}</button>`).join('')}</div>
    <span class="field">Finger colors</span>
    ${['L','R'].map(h => `<div class="row"><b style="width:52px">${h === 'L' ? 'Left' : 'Right'}</b>${[1,2,3,4,5].map(f => `<label class="swatch"><input type="color" data-fcolor="${h}${f}" value="${fColor(h, f)}"><span>${f}</span></label>`).join('')}</div>`).join('')}
    <span class="field">Note colors</span>
    <div class="row">${['C','D','E','F','G','A','B'].map(L => `<label class="swatch"><input type="color" data-color="${L}" value="${settings.colors[L]}"><span>${L === 'B' && settings.naming === 'H' ? 'H' : L}</span></label>`).join('')}</div>
    <span class="field">Black key colors</span>
    <div class="row">${Object.keys(DEFAULT_BLACK).map(L => `<label class="swatch"><input type="color" data-bcolor="${L}" value="${settings.blackColors[L]}"><span>${settings.naming === 'H' ? CZ[L] : L}</span></label>`).join('')}</div>
    <div class="row" style="margin-top:10px"><button class="btn quiet" data-act="reset-colors">Reset colors</button></div>
    ${cloud ? `<span class="field">Account</span>
    <div class="row"><span>${esc(cloud.user.email || cloud.user.displayName || 'Signed in')}</span><button class="btn quiet" data-act="sign-out">Sign out</button></div>` : ''}
    <span class="field">Backup</span>
    <div class="row"><button class="btn" data-act="export">Save backup file</button>
      <span class="btn quiet file">Restore from file<input id="import-in" type="file" accept="application/json,.json"></span></div>`;
}
function renderBar(){
  const m = {ok:['ok','Keyboard: '+midiName], none:['','No keyboard found. Plug in USB.'], unsupported:['','Open in Chrome to use the keyboard'],
             denied:['','Keyboard blocked. Tap to retry.'], idle:['','Connect keyboard']}[midiState];
  const el = document.getElementById('midi'); el.className = 'pill ' + m[0]; el.textContent = m[1];
}
function render(){
  renderBar();
  const app = document.getElementById('app');
  app.innerHTML = {home:homeHTML, edit:editHTML, play:playHTML, done:doneHTML, settings:settingsHTML}[view]();
  if (view === 'edit') app.querySelector('.chip.sel')?.scrollIntoView({inline:'nearest', block:'nearest'});
  if (view === 'play') app.querySelector('.key.target')?.scrollIntoView({inline:'center', block:'nearest'});
}
let toastT;
function toast(msg){ const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }

// ---------- Events ----------
document.addEventListener('pointerdown', e => {
  const k = e.target.closest('.key'); if (!k) return;
  e.preventDefault(); handleNote(+k.dataset.p, 'screen');
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, v = b.dataset.v;
  switch (a){
    case 'new': newExercise(); break;
    case 'play': startPlay(b.dataset.id); break;
    case 'edit': openEdit(b.dataset.id); break;
    case 'br': edit.notes[edit.sel].br = !edit.notes[edit.sel].br; render(); break;
    case 'split-hand': splitByHand(edit.notes); render(); break;
    case 'clear-br': edit.notes.forEach(n => delete n.br); render(); break;
    case 'trk-hand': edit.midi.choices.find(c => c.i === +b.dataset.i).hand = v; renderMidiDialog(); break;
    case 'midi-bars': edit.midi.bars = +v; renderMidiDialog(); break;
    case 'midi-cancel': closeOverlay(); break;
    case 'midi-import': finishMidiImport(); break;
    case 'mode':
      if (v === 'text'){
        const same = JSON.stringify(parseExercise({...textOpts(), text:edit.text}).notes.map(n => keysOf(n).map(k => [k.p,k.f,k.h])))
                  === JSON.stringify(edit.notes.map(n => keysOf(n).map(k => [k.p,k.f,k.h])));
        if (!same && edit.notes.length){ edit.lineBlocks = edit.notes.some(n => n.br); edit.text = notesToText(edit.notes, textOpts()); }
        reparse();
      }
      edit.mode = v; render(); break;
    case 'bpm': edit.bpm = clamp(edit.bpm + (+v), 30, 200); render(); break;
    case 'listen-edit': if (edit.notes.length) listen(edit.notes, edit.bpm, hearChip); break;
    case 'listen-play': {
      const [a, b] = blocksOf(play.ex)[blockIndex(blocksOf(play.ex), Math.min(play.i, play.ex.notes.length-1))];
      listen(play.ex.notes.slice(a, b), play.ex.bpm || 80);   // just the current step
    } break;
    case 'replay': {
      // her real timing; in phone-sound mode only the notes she actually heard (correct ones)
      const L = play.log.filter(x => x.ok || !settings.appSound);
      runSeq(L.map((x, i) => ({ps:[x.p], wait: i ? clamp(x.t - L[i-1].t, 0, 1500) : 0})));
    } break;
    case 'home': stopPlayback(); releaseWake(); view = 'home'; edit = null; play = null; render(); break;
    case 'save': saveEdit(); break;
    case 'del-ex':
      if (confirm('Delete this exercise?')){
        exercises = exercises.filter(x => x.id !== edit.id); await store.del('photo:'+edit.id);
        await saveList(); edit = null; view = 'home'; render();
      } break;
    case 'sel': if (edit.mode === 'keys'){ edit.sel = +b.dataset.i; render(); } break;
    case 'hand': edit.notes[edit.sel].h = v; render(); break;
    case 'finger': edit.notes[edit.sel].f = +v; render(); break;
    case 'del-note': edit.notes.splice(edit.sel, 1); edit.sel = Math.min(edit.sel, edit.notes.length-1); render(); break;
    case 'addf': { const h = b.dataset.h, f = +v; insertNote(fingerPitch(h, f, edit['thumb'+h]), f, h); } break;
    case 'thumb': { const k = 'thumb'+b.dataset.h; edit[k] = clamp(whiteStep(edit[k], +v), 36, 84); render(); } break;
    case 'style': settings.style = v; await store.set('settings', settings); render(); break;
    case 'sound': settings.appSound = v === 'true'; await store.set('settings', settings); render(); break;
    case 'next-step': play.stepDone = false; render(); break;
    case 'oct': edit.oct = clamp(edit.oct + (+v), 1, 6); render(); break;
    case 'icon': edit.icon = v; render(); break;
    case 'emoji-picker': openEmojiPicker(); break;
    case 'again': startPlay(play.src.id, play.hand); break;
    case 'play-hand': play.src.practiceHand = v; saveList(); startPlay(play.src.id, v); break;
    case 'settings': view = 'settings'; render(); break;
    case 'naming': settings.naming = v; await store.set('settings', settings); render(); break;
    case 'reset-colors': settings.colors = {...DEFAULT_COLORS}; settings.blackColors = {...DEFAULT_BLACK}; settings.fingerColors = fingerDefaults(); await store.set('settings', settings); render(); break;
    case 'export': exportAll(); break;
    case 'midi': initMidi(); break;
    case 'sign-in':
      try{ await cloud.signIn(); location.reload(); }
      catch(e){
        console.error(e);
        if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') break;
        const el = document.getElementById('signin-err');   // keep the exact reason on screen, not in a 2 s toast
        if (el) el.textContent = `Sign-in failed: ${e.code || e.message}`;
      } break;
    case 'sign-out': await cloud.signOut(); location.reload(); break;
  }
});
document.getElementById('overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeOverlay(); }); // tap outside to close

function closeOverlay(){ const o = document.getElementById('overlay'); o.hidden = true; o.innerHTML = ''; if (edit) edit.midi = null; }

// ---------- MIDI file import ----------
async function startMidiImport(file){
  let midi;
  try{ midi = await readMidi(file); }catch(e){ console.error(e); toast('Could not read that MIDI file'); return; }
  const tracks = summarize(midi);
  if (!tracks.length){ toast('No notes found in that file'); return; }
  edit.midi = {midi, tracks, choices: defaultChoices(tracks), bars: 1, file: file.name.replace(/\.(mid|midi)$/i, '')};
  renderMidiDialog();
}
function renderMidiDialog(){
  const m = edit.midi, o = document.getElementById('overlay');
  const range = t => `${name(t.lo)}${octave(t.lo)}–${name(t.hi)}${octave(t.hi)}`;
  o.innerHTML = `<div class="dialog" role="dialog" aria-label="Import MIDI file">
    <h2>Import ${esc(m.file)}</h2>
    <p class="muted">Keep only what she plays, usually the melody. "Split" sends notes from middle C up to the right hand.</p>
    ${m.tracks.map(t => { const c = m.choices.find(x => x.i === t.i); return `<div class="trk">
      <label class="check"><input type="checkbox" data-trk="${t.i}"${c.on ? ' checked' : ''}> ${esc(t.name)}</label>
      <span class="muted">${t.count} notes, ${range(t)}</span>
      <div class="seg">${[['L','Left'],['R','Right'],['auto','Split']].map(([k,l]) => `<button class="${c.hand === k ? 'on' : ''}" data-act="trk-hand" data-i="${t.i}" data-v="${k}">${l}</button>`).join('')}</div></div>`; }).join('')}
    <span class="field">Bars per line</span>
    <div class="seg">${[1,2,4].map(k => `<button class="${m.bars === k ? 'on' : ''}" data-act="midi-bars" data-v="${k}">${k}</button>`).join('')}</div>
    ${edit.text.trim() ? '<p class="warn-line">Replaces the notes already typed.</p>' : ''}
    <div class="row spread" style="margin-top:16px"><button class="btn quiet" data-act="midi-cancel">Cancel</button><button class="btn primary" data-act="midi-import">Import</button></div>
  </div>`;
  o.hidden = false;
}
function finishMidiImport(){
  const m = edit.midi, {steps, bpm} = midiToSteps(m.midi, m.choices);
  if (!steps.length){ toast('Pick at least one track'); return; }
  if (bpm) edit.bpm = clamp(Math.round(bpm/10)*10, 30, 200);
  edit.text = stepsToText(steps, textOpts(), m.bars);
  if (!edit.name.trim()) edit.name = m.file;
  closeOverlay(); reparse(); render();
  toast(`Imported ${edit.notes.length} steps`);
}

// Full emoji picker with search (web component, loaded only when opened)
async function openEmojiPicker(){
  const o = document.getElementById('overlay');
  try{ await import('https://cdn.jsdelivr.net/npm/emoji-picker-element@1.29.1/index.js'); }
  catch(e){ console.error(e); toast('Could not load the emoji list. Check the connection.'); return; }
  o.innerHTML = '<emoji-picker class="light"></emoji-picker>';
  o.querySelector('emoji-picker').addEventListener('emoji-click', ev => {
    edit.icon = ev.detail.unicode; o.hidden = true; o.innerHTML = ''; render();
  });
  o.hidden = false;
}
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'exname') edit.name = t.value;
  else if (t.id === 'extext'){ edit.text = t.value; reparse(); refreshDerived(); }
  else if (t.id === 'lineblocks'){ edit.lineBlocks = t.checked; reparse(); refreshDerived(); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'import-in' && t.files[0]) importAll(t.files[0]);
  else if (t.id === 'midi-in' && t.files[0]){ const file = t.files[0]; t.value = ''; startMidiImport(file); }
  else if (t.dataset.trk != null && edit?.midi){ edit.midi.choices.find(c => c.i === +t.dataset.trk).on = t.checked; }
  else if (t.dataset.color){ settings.colors[t.dataset.color] = t.value; await store.set('settings', settings); }
  else if (t.dataset.bcolor){ settings.blackColors[t.dataset.bcolor] = t.value; await store.set('settings', settings); render(); }
  else if (t.dataset.fcolor){ const [h, f] = t.dataset.fcolor; settings.fingerColors[h][f] = t.value; await store.set('settings', settings); }
});

// ---------- Start ----------
async function load(){
  if (backend){
    try{
      exercises = (await backend.get('exercises')) || [];
      const s = await backend.get('settings'); if (s) settings = mergeSettings(s);
    }catch(e){
      console.error(e); loadFailed = true;
      if (e.code === 'permission-denied'){ noAccess = true; return; }   // signed in with an account not on the list
      toast('Offline: lessons could not load.');
    }
  } else {
    exercises = (await store.get('exercises')) || [];
    const s = await store.get('settings'); if (s) settings = mergeSettings(s);
  }
}

// Fill an empty family space once: from this user's earlier private space, else from this browser
async function migrateLocal(){
  try{ if (await backend.get('exercises')) return; }catch(e){ return; }   // already filled, or unknown (offline / no access) → do nothing
  let local = null, from = 'this phone';
  try{
    const mine = cloud.store(['users', cloud.user.uid, 'data']);
    local = await mine.get('exercises');
    const s = await mine.get('settings'); if (local && local.length){ from = 'your account'; if (s) store.set('settings', s); }
  }catch(e){}
  if (!local || !local.length){ try{ local = JSON.parse(localStorage.getItem('exercises') || 'null'); }catch(e){} }
  if (!local || !local.length) return;
  local.forEach(ex => delete ex.hasPhoto);
  store.set('exercises', local);                       // queued; don't wait for the server
  if (from === 'this phone'){ try{ const s = JSON.parse(localStorage.getItem('settings') || 'null'); if (s) store.set('settings', s); }catch(e){} }
  toast(`Moved ${local.length} lesson${local.length === 1 ? '' : 's'} from ${from} to the family lessons`);
}

function noAccessHTML(){
  return `<section class="done"><div class="ico-big" aria-hidden="true">🔒</div><h1>No access</h1>
    <p class="muted">${esc(cloud.user.email || '')} is not on the family list.</p>
    <button class="btn" data-act="sign-out">Use another account</button></section>`;
}
function signInHTML(){
  return `<section class="done"><div class="ico-big" aria-hidden="true">🎹</div><h1>Piano steps</h1>
    <p class="muted">Sign in to keep lessons in sync on every device.</p>
    <button class="btn primary big" data-act="sign-in">Sign in with Google</button>
    <p id="signin-err" class="muted" role="alert" style="color:#B83227"></p></section>`;
}

(async () => {
  try{ cloud = await connectCloud(); }catch(e){ console.error(e); cloud = null; }
  if (cloud && !cloud.user){ renderBar(); document.getElementById('app').innerHTML = signInHTML(); return; }
  if (cloud){ backend = cloud.store(['spaces', 'family', 'data']); await migrateLocal(); }
  await load();
  if (noAccess){ renderBar(); document.getElementById('app').innerHTML = noAccessHTML(); return; }
  render();
  initMidi();
})();
