/*
 * Свара — AI Арена: the UI. Screens (Home → Stakes → Table), the event-driven table renderer,
 * the single game loop that drives the bots, persistence and the debug hook.
 * Needs SvaraEngine (engine.js) and SvaraAI (ai.js), loaded before this classic script.
 *
 * How the table works: every engine call goes through step(), which takes a snapshot of the
 * state *before* the call and then animates the returned events one by one. The screen is
 * driven by a small view model (T.view) that is updated from the events only, because a single
 * call can run far ahead (a svara replay or even a whole hand can resolve inside one call).
 * After each step the view is checked against the engine state.
 */
(function () {
  'use strict';

  const E = window.SvaraEngine;
  const AI = window.SvaraAI;
  if (!E || !AI) throw new Error('Свара: engine.js and ai.js must be loaded before app.js');

  // ---------------------------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------------------------

  const STORAGE_KEY = 'svara.v1';
  const START_BANKROLL = 5000;
  const FREE_CHIPS = 1000;
  const HUMAN_ID = 'me';
  const HUMAN_NAME = 'Ти';
  const HUMAN_AVATAR = '🧑';
  const SEATS = 6; // seat 0 = you (bottom), seats 1..5 = the opponent row, left to right (clockwise)

  // 8 stops of the stakes slider; buy-in range = 20×bb … 100×bb
  const STAKES = [[1, 2], [5, 10], [25, 50], [50, 100], [250, 500], [1000, 2000], [5000, 10000], [25000, 50000]]
    .map(([ante, bb]) => ({ ante, bb, minBuyIn: 20 * bb, maxBuyIn: 100 * bb }));

  // Bot pool: Bulgarian names, emoji avatars, a personality each and a fixed fictional weekly XP.
  const BOT_POOL = [
    { key: 'iva', name: 'Ива', avatar: '🐭', personality: 'tag', xp: 2215 },
    { key: 'mitko', name: 'Митко', avatar: '😆', personality: 'lag', xp: 6264 },
    { key: 'gosho', name: 'Гошо', avatar: '🐼', personality: 'rock', xp: 1760 },
    { key: 'pesho', name: 'Пешо', avatar: '🧔', personality: 'fish', xp: 240 },
    { key: 'sasho', name: 'Сашо', avatar: '😎', personality: 'maniac', xp: 1204 },
    { key: 'neli', name: 'Нели', avatar: '👩', personality: 'tag', xp: 8350 },
    { key: 'bobo', name: 'Бобо', avatar: '🐻', personality: 'rock', xp: 880 },
    { key: 'toni', name: 'Тони', avatar: '🦊', personality: 'lag', xp: 2940 },
    { key: 'desi', name: 'Деси', avatar: '🐱', personality: 'fish', xp: 3518 },
    { key: 'krasi', name: 'Краси', avatar: '🤠', personality: 'lag', xp: 13600 },
    { key: 'valyo', name: 'Вальо', avatar: '👨‍🦲', personality: 'rock', xp: 96 },
    { key: 'mimi', name: 'Мими', avatar: '👵', personality: 'fish', xp: 512 },
  ];

  // Text-presentation suits (U+FE0E) so ♥♦ never turn into emoji.
  const SUIT = { s: '♠︎', h: '♥︎', d: '♦︎', c: '♣︎' };
  const RED = { h: true, d: true };
  const MEDALS = ['🥇', '🥈', '🥉'];

  // ---------------------------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------------------------

  const NNBSP = ' '; // bg-BG groups thousands with a narrow no-break space: 5 000

  function fmt(n) {
    const v = Math.round(n || 0);
    const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
    return v < 0 ? '−' + s : s;
  }

  /** 1000 → 1K, 12500 → 12,5K, 1000000 → 1M (as in the reference). */
  function fmtShort(n) {
    const one = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
    if (n >= 1e6) return one(n / 1e6) + 'M';
    if (n >= 1e3) return one(n / 1e3) + 'K';
    return String(n);
  }

  /** Amounts in bubbles and buttons: exact up to 9 999, short above. */
  const fmtAmt = (n) => (n >= 10000 ? fmtShort(n) : fmt(n));

  /** Millions with up to two decimals, rounded down so it never shows more than there is: 1,07M. */
  const fmtMillions = (n) => String(Math.floor(n / 1e4) / 100).replace('.', ',') + 'M';
  /** Seat stacks sit in narrow columns: exact below 1 000 000, then 1,07M. */
  const fmtSeatStack = (n) => (n >= 1e6 ? fmtMillions(n) : fmt(n));
  /** The info-box stack and the home bankroll have room for 7 digits: 9 999 999, then 12,34M. */
  const fmtWide = (n) => (n >= 1e7 ? fmtMillions(n) : fmt(n));
  const pct = (x) => `${Math.round(x * 100)}%`;

  // ---------------------------------------------------------------------------------------------
  // Motion helpers (every duration is multiplied by SPEED; reduced motion skips movement)
  // ---------------------------------------------------------------------------------------------

  let SPEED = 1;
  const mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(mqReduce && mqReduce.matches);
  const dur = (ms) => Math.max(0, ms * SPEED);
  const rand = (a, b) => a + Math.random() * (b - a);

  /** Always yields to the event loop (a macrotask), even at speed 0. */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, dur(ms)));
  }

  function settle(animation, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms + 150); // hidden tabs may never finish an animation
      animation.finished.then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); });
    });
  }

  /**
   * Web Animations wrapper. Elements always hold their final state in CSS; animations only show
   * the way there, so skipping one (tiny speed, no WAAPI) is always safe.
   */
  function anim(node, frames, opts = {}) {
    if (reduced()) {
      // Reduced motion: nothing moves or scales; what is left of an animation is a short fade.
      frames = frames.map(({ transform, ...rest }) => rest);
      if (!frames.some((f) => 'opacity' in f)) return Promise.resolve();
      opts = { ...opts, duration: Math.min(opts.duration || 0, 120) };
    }
    const d = dur(opts.duration || 0);
    const delay = dur(opts.delay || 0);
    if (!node || typeof node.animate !== 'function' || d < 1) return Promise.resolve();
    let a;
    try {
      a = node.animate(frames, { duration: d, delay, easing: opts.easing || 'ease-out', fill: opts.fill || 'none' });
    } catch (e) {
      return Promise.resolve();
    }
    return settle(a, d + delay);
  }

  /** True when an effect would be skipped: reduced motion, no WAAPI, or too fast to see. */
  const still = (ms, node) => reduced() || dur(ms) < 4 || (node && typeof node.animate !== 'function');

  /**
   * Mini card flip in 3D: it turns edge-on (perspective + rotateY, lifting a little), is
   * repainted there, and turns on to face up. A mini is one element, so the swap happens at 90°.
   */
  async function flipMini(node, paint, delay = 0) {
    if (still(260, node)) {
      paint();
      if (reduced()) await anim(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      return;
    }
    const P = 'perspective(140px)';
    const a1 = node.animate([
      { transform: `${P} rotateY(0deg)`, filter: 'brightness(1)' },
      { transform: `${P} translateY(-3px) rotateY(90deg)`, filter: 'brightness(.7)' },
    ], { duration: dur(110), delay: dur(delay), easing: 'ease-in', fill: 'forwards' });
    await settle(a1, dur(110 + delay));
    paint();
    const a2 = node.animate([
      { transform: `${P} translateY(-3px) rotateY(-90deg)`, filter: 'brightness(.7)' },
      { transform: `${P} rotateY(0deg)`, filter: 'brightness(1)' },
    ], { duration: dur(150), easing: 'cubic-bezier(.2,.7,.3,1)' });
    a1.cancel();
    await settle(a2, dur(150));
  }

  // Animated counters: ease-out, integers formatted on every frame, optional green/coral tone.
  const countJobs = new Map();
  const easeCubic = (k) => 1 - Math.pow(1 - k, 3);
  const easeExpo = (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k));

  // A node can carry its own number format (node._fmt), e.g. the short seat stacks.
  function setNum(node, v, format) {
    if (!node) return;
    format = format || node._fmt || fmt;
    node._v = v;
    node.textContent = format(v);
  }

  function stopCount(node) {
    const job = countJobs.get(node);
    if (job) job.stop();
  }

  function countTo(node, to, ms = 500, opts = {}) {
    if (!node) return Promise.resolve();
    const format = opts.format || node._fmt || fmt;
    stopCount(node);
    const from = typeof node._v === 'number' ? node._v : to;
    const d = reduced() ? 0 : dur(ms);
    node.classList.remove('up', 'down');
    if (from === to || d < 16) {
      setNum(node, to, format);
      return Promise.resolve();
    }
    const tone = opts.tone ? (to > from ? 'up' : 'down') : null;
    if (tone) node.classList.add(tone);
    const ease = opts.ease || easeCubic;
    return new Promise((resolve) => {
      const t0 = performance.now();
      let raf = 0;
      let fallback = 0;
      const job = {
        stop() {
          cancelAnimationFrame(raf);
          clearTimeout(fallback);
          countJobs.delete(node);
          setNum(node, to, format);
          resolve();
        },
      };
      const end = () => {
        job.stop();
        if (tone) setTimeout(() => { if (!countJobs.has(node)) node.classList.remove(tone); }, dur(opts.hold == null ? 400 : opts.hold));
      };
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / d);
        setNum(node, Math.round(from + (to - from) * ease(k)), format);
        if (k >= 1) end();
        else raf = requestAnimationFrame(tick);
      };
      fallback = setTimeout(end, d + 200);
      countJobs.set(node, job);
      raf = requestAnimationFrame(tick);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Motion kit: springs, arcs, haptics
  // ---------------------------------------------------------------------------------------------

  const mix = (a, b, v) => a + (b - a) * v;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  /** A damped spring from 0 to 1 over progress k ∈ [0, 1], settled at 1; damping < 1 overshoots. */
  function springAt(k, damping = 0.55) {
    if (k <= 0) return 0;
    if (k >= 1) return 1;
    const w = 10;
    const wd = w * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * w * k) * (Math.cos(wd * k) + ((damping * w) / wd) * Math.sin(wd * k));
  }

  /** Keyframes that follow a spring: make(v) builds the frame for the spring value v. Play them linearly. */
  function springFrames(make, damping, steps = 20) {
    const frames = [];
    for (let i = 0; i <= steps; i++) frames.push({ ...make(springAt(i / steps, damping)), offset: i / steps });
    return frames;
  }

  /** Bézier control point that bows the path a → b sideways by `bend` × its length (signed). */
  function bowCtrl(a, b, bend) {
    return { x: (a.x + b.x) / 2 - (b.y - a.y) * bend, y: (a.y + b.y) / 2 + (b.x - a.x) * bend };
  }

  /** Control point for a toss: `hop` px above the higher end. */
  function hopCtrl(a, b, hop) {
    return { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - hop };
  }

  /** Bend outwards (away from the vertical through the start), or a little when the path is vertical. */
  function outward(a, b, amount) {
    if (Math.abs(b.x - a.x) < 12) return amount * 0.25;
    return (b.x - a.x) * (b.y - a.y) > 0 ? -amount : amount;
  }

  /**
   * Keyframes for a flight along a quadratic Bézier from centre a to centre b (viewport px). The
   * node is a w×h box at 0,0 with a centred transform origin. It scales s0 → s1 ([x, y]), grows by
   * `lift` at the top of the arc, spins `spin`° down to 0 (or turns from 0 to `turn`°) and
   * `opacity(t)` adds a fade.
   */
  function arcFrames(a, b, ctrl, { w, h, s0 = [1, 1], s1 = [1, 1], lift = 0, spin = 0, turn = 0, opacity = null, steps = 12 }) {
    const frames = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x;
      const y = u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y;
      const grow = 1 + lift * 4 * t * u;
      const frame = {
        offset: t,
        transform: `translate(${(x - w / 2).toFixed(1)}px, ${(y - h / 2).toFixed(1)}px) rotate(${(spin * u * u + turn * t * t).toFixed(1)}deg) ` +
          `scale(${(mix(s0[0], s1[0], t) * grow).toFixed(3)}, ${(mix(s0[1], s1[1], t) * grow).toFixed(3)})`,
      };
      if (opacity) frame.opacity = clamp(opacity(t), 0, 1);
      frames.push(frame);
    }
    return frames;
  }

  /** Short vibrations (Android browsers); silently nothing elsewhere. */
  const HAPTICS = { turn: [12], allin: [18, 40, 28], win: [14, 60, 14, 60, 30], svara: [40, 70, 40, 70, 90] };
  function haptic(kind) {
    try {
      if (typeof navigator.vibrate === 'function' && HAPTICS[kind]) navigator.vibrate(HAPTICS[kind]);
    } catch (e) {
      /* vibration blocked or unsupported */
    }
  }

  /** A small horizontal shake (none with reduced motion). */
  function shake(node, px = 3, ms = 250) {
    if (reduced()) return Promise.resolve();
    const frames = [0, -1, 0.9, -0.7, 0.5, -0.3, 0].map((k) => ({ transform: `translate3d(${(k * px).toFixed(1)}px, 0, 0)` }));
    return anim(node, frames, { duration: ms, easing: 'linear' });
  }

  /** Spring pop for something that just appeared (a bubble, a pill). */
  function popIn(node, from = 0.4, damping = 0.45) {
    return anim(node, springFrames((v) => ({ transform: `scale(${mix(from, 1, v).toFixed(3)})`, opacity: clamp(v * 2, 0, 1) }), damping),
      { duration: 420, easing: 'linear' });
  }

  /** A happy bounce (a winner's avatar). */
  function bounce(node) {
    return anim(node, [
      { transform: 'none' },
      { transform: 'translateY(-9px) scale(1.14)', offset: 0.3 },
      { transform: 'translateY(1px) scale(.96)', offset: 0.6 },
      { transform: 'translateY(-1px) scale(1.01)', offset: 0.82 },
      { transform: 'none' },
    ], { duration: 560, easing: 'ease-out' });
  }
  // ---------------------------------------------------------------------------------------------
  // Profile & persistence
  // ---------------------------------------------------------------------------------------------

  const P = { bankroll: START_BANKROLL, xp: 0, handsPlayed: 0, handsWon: 0, biggestPot: 0 };

  function sanitizeProfile(d) {
    const int = (v, def) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : def);
    const src = d && typeof d === 'object' ? d : {};
    return {
      bankroll: int(src.bankroll, START_BANKROLL),
      xp: int(src.xp, 0),
      handsPlayed: int(src.handsPlayed, 0),
      handsWon: int(src.handsWon, 0),
      biggestPot: int(src.biggestPot, 0),
    };
  }

  function loadStored() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? sanitizeProfile(JSON.parse(raw)) : null;
    } catch (e) {
      return null; // storage blocked or corrupt: play without it
    }
  }

  /** The human's chips at the table (committed chips of a running hand are not included). */
  function tableStack() {
    if (!T.game) return 0;
    try {
      const me = T.game.getState().players.find((p) => p.id === HUMAN_ID);
      return me ? me.stack : 0;
    } catch (e) {
      return 0;
    }
  }

  /** What is stored and what a hot reload keeps: the profile with the table stack returned. */
  function profileSnapshot() {
    return {
      bankroll: P.bankroll + tableStack(),
      xp: P.xp, handsPlayed: P.handsPlayed, handsWon: P.handsWon, biggestPot: P.biggestPot,
    };
  }

  function saveProfile() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profileSnapshot()));
    } catch (e) {
      /* storage unavailable: the game keeps working in memory */
    }
  }

  function levelInfo(xp) {
    const level = Math.floor(Math.sqrt(xp / 20));
    const lo = 20 * level * level;
    const hi = 20 * (level + 1) * (level + 1);
    return { level, progress: (xp - lo) / (hi - lo) };
  }

  // ---------------------------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const el = {};
  const screens = {};
  const sheets = {};
  let screenName = 'home';

  function div(cls, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  let toastTimer = 0;
  function hideToast() {
    clearTimeout(toastTimer);
    el.toast.classList.remove('show');
  }
  function toast(msg) {
    el.toast.textContent = msg;
    const onTable = screenName === 'table';
    el.toast.classList.toggle('on-table', onTable);
    // On the table it sits in the empty band between the opponents and the deck (the stacked deck
    // layers reach 4 px above its top), clear of avatars, labels and bets.
    el.toast.style.top = '';
    const opps = onTable && rectOf(el.opps);
    const deck = onTable && rectOf(el.deckTop);
    if (opps && deck) {
      const top = (opps.bottom + deck.top - 4 - el.toast.offsetHeight) / 2;
      el.toast.style.top = `${Math.round(Math.max(opps.bottom + 4, top))}px`;
    }
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1900);
  }

  // ---------------------------------------------------------------------------------------------
  // Sheets (leave, raise, svara offer, busted): one at a time; the leave sheet defers the others
  // ---------------------------------------------------------------------------------------------

  let openName = null;
  let deferredSheet = null;
  let focusBefore = null;

  function openSheet(name, setup) {
    if (openName === 'leave' && name !== 'leave') {
      deferredSheet = { name, setup }; // e.g. the svara offer arrives while "Сигурен ли си?" is up
      return;
    }
    if (openName && openName !== name) hideSheetNow(openName);
    else if (!openName) focusBefore = document.activeElement;
    if (setup) setup();
    const s = sheets[name];
    el.sheetLayer.hidden = false;
    s.hidden = false;
    void s.offsetHeight; // start the slide from off-screen
    el.sheetLayer.classList.add('open');
    s.classList.add('open');
    openName = name;
    const first = s.querySelector('button:not(:disabled), input');
    if (first) setTimeout(() => { if (openName === name) first.focus({ preventScroll: true }); }, dur(60));
  }

  function hideSheetNow(name) {
    const s = sheets[name];
    s.classList.remove('open');
    s.hidden = true;
    if (openName === name) openName = null;
  }

  function closeSheet(name) {
    if (openName !== name) return;
    const s = sheets[name];
    openName = null;
    s.classList.remove('open');
    el.sheetLayer.classList.remove('open');
    setTimeout(() => {
      if (openName !== name) s.hidden = true;
      if (!openName) el.sheetLayer.hidden = true;
    }, dur(150));
    if (focusBefore && document.contains(focusBefore) && !deferredSheet) {
      try { focusBefore.focus({ preventScroll: true }); } catch (e) { /* not focusable any more */ }
    }
    focusBefore = null;
    if (name === 'leave' && deferredSheet) {
      const d = deferredSheet;
      deferredSheet = null;
      // reopen only if the loop is still waiting for that answer (not after leaving the table)
      setTimeout(() => { if (T.game && T.waiting && T.waiting.kind === d.name) openSheet(d.name, d.setup); }, dur(160));
    }
  }

  function closeAllSheets() {
    deferredSheet = null;
    for (const name of Object.keys(sheets)) {
      sheets[name].classList.remove('open');
      sheets[name].hidden = true;
    }
    openName = null;
    el.sheetLayer.classList.remove('open');
    el.sheetLayer.hidden = true;
  }

  // ---------------------------------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------------------------------

  function renderHome(updateBankroll) {
    if (updateBankroll) setNum(el.homeBankroll, P.bankroll);
    el.homeXp.textContent = fmt(P.xp);
    const lv = levelInfo(P.xp);
    el.levelValue.textContent = String(lv.level);
    el.levelArc.style.strokeDasharray = `${(Math.max(0.06, lv.progress) * 100.5).toFixed(1)} 101`;
    el.freeChips.hidden = P.bankroll >= STAKES[0].minBuyIn;
    renderLeaderboard();
  }

  function renderLeaderboard() {
    const rows = BOT_POOL.map((b) => ({ name: b.name, avatar: b.avatar, xp: b.xp }))
      .concat({ name: HUMAN_NAME, avatar: HUMAN_AVATAR, xp: P.xp, me: true })
      .sort((a, b) => b.xp - a.xp || (a.me ? -1 : b.me ? 1 : 0));
    const items = rows.map((r, i) => {
      const li = document.createElement('li');
      if (r.me) { li.className = 'me'; li.id = 'lb-me'; }
      const rank = i < 3 ? div('lb-medal', MEDALS[i]) : div('lb-rank num', String(i + 1));
      const text = div('lb-text');
      text.append(div('lb-name', r.name), div('lb-xp num', `${fmt(r.xp)} XP`));
      li.append(rank, div('lb-avatar', r.avatar), text);
      return li;
    });
    el.leaderboard.replaceChildren(...items);
  }

  /**
   * Mode carousel: the centred card is full size, its neighbours shrink to 0.9. While the
   * carousel scrolls the cards also tilt in 3D, facing the centre (CSS shows the tilt only then).
   */
  let modeRaf = 0;
  let modeIdle = 0;
  function updateModeScale() {
    modeRaf = 0;
    const box = el.modes.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cards = Array.from(el.modes.children);
    // read every position first, then write: no layout between the writes
    const offs = cards.map((card) => {
      const r = card.getBoundingClientRect();
      return { d: r.left + r.width / 2 - cx, w: card.offsetWidth || 1 };
    });
    cards.forEach((card, i) => {
      const { d, w } = offs[i];
      const t = clamp((Math.abs(d) - 20) / w, 0, 1);
      card.style.setProperty('--mode-scale', (1 - 0.1 * t).toFixed(3));
      card.style.setProperty('--mode-tilt', `${(clamp(d / w, -1, 1) * 14).toFixed(2)}deg`);
    });
  }

  function onModesScroll() {
    el.modes.classList.add('scrolling');
    clearTimeout(modeIdle);
    modeIdle = setTimeout(() => el.modes.classList.remove('scrolling'), 140); // the tilt springs back
    if (!modeRaf) modeRaf = requestAnimationFrame(updateModeScale);
  }

  function showOnly(name) {
    for (const [n, s] of Object.entries(screens)) s.hidden = n !== name;
  }

  // The AI Арена card and the stakes panel, for the shared-element morph between them.
  const AI_CARD = { fill: 'var(--grad-ai)', corners: [28, 28, 28, 28] };
  const PANEL = { fill: 'var(--panel-grad)', corners: [0, 0, 40, 40] };

  /** Tapping AI Арена: the card grows into the stakes panel while the home screen falls back. */
  async function goStakes() {
    if (screenName !== 'home') return;
    screenName = 'stakes';
    hideToast();
    stakeIdx = defaultStake();
    renderStakes();
    setNum(el.stakesBankroll, P.bankroll);
    const card = rectOf(el.modeAi);
    screens.stakes.hidden = false;
    const panel = rectOf(el.stakesPanel);
    if (!card || !panel || still(380)) {
      const frames = reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: 'translateY(100%)' }, { transform: 'none' }];
      await anim(screens.stakes, frames, { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    } else {
      anim(screens.home, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: 300, easing: 'ease-in' })
        .then(() => { if (screenName === 'stakes') screens.home.hidden = true; });
      const content = anim(screens.stakes, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 170, fill: 'backwards' });
      const ghost = await morph(card, panel, { fillA: AI_CARD.fill, fillB: PANEL.fill, cornersA: AI_CARD.corners, cornersB: PANEL.corners });
      await content;
      dropFx(ghost);
    }
    if (screenName === 'stakes') {
      screens.home.hidden = true;
      el.stakesSlider.focus({ preventScroll: true });
    }
  }

  /** Back: the panel shrinks into the AI Арена card again. */
  async function backHome() {
    if (screenName !== 'stakes') return;
    screenName = 'home';
    hideToast();
    screens.home.hidden = false;
    renderHome(true);
    const panel = rectOf(el.stakesPanel);
    const card = rectOf(el.modeAi);
    if (!card || !panel || still(340)) {
      const frames = reduced() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'none' }, { transform: 'translateY(100%)' }];
      await anim(screens.stakes, frames, { duration: 200, easing: 'ease-in' });
      if (screenName === 'home') screens.stakes.hidden = true;
      return;
    }
    el.modeAi.style.opacity = '0'; // the morph lands where the card is
    anim(screens.stakes, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' })
      .then(() => { if (screenName === 'home') screens.stakes.hidden = true; });
    anim(screens.home, [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' });
    const ghost = await morph(panel, card, { fillA: PANEL.fill, fillB: AI_CARD.fill, cornersA: PANEL.corners, cornersB: AI_CARD.corners, duration: 340 });
    el.modeAi.style.opacity = '';
    ghost.remove();
  }

  /** Leaving: the table fades and shrinks away, home comes forward, then the bankroll counts. */
  async function homeFromTable() {
    screenName = 'home';
    hideToast();
    screens.home.hidden = false;
    screens.stakes.hidden = true;
    renderHome(false); // keep the old number: it counts to the new bankroll below
    el.homeScroll.scrollTop = 0;
    const home = anim(screens.home, [{ opacity: 0, transform: 'scale(1.04)' }, { opacity: 1, transform: 'none' }],
      { duration: 360, delay: 170, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    await anim(screens.table, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: 280, easing: 'ease-in' });
    if (screenName !== 'home') return;
    screens.table.hidden = true;
    requestAnimationFrame(updateModeScale);
    await home;
    await sleep(300);
    if (screenName !== 'home') return;
    await countTo(el.homeBankroll, P.bankroll, 1100, { tone: true, ease: easeExpo, hold: 300 });
    el.freeChips.hidden = P.bankroll >= STAKES[0].minBuyIn;
  }

  // ---------------------------------------------------------------------------------------------
  // Stakes picker
  // ---------------------------------------------------------------------------------------------

  let stakeIdx = 1;
  let lastStakeIdx = 1;
  const affordable = (i) => P.bankroll >= STAKES[i].minBuyIn;

  function defaultStake() {
    if (affordable(lastStakeIdx)) return lastStakeIdx;
    let best = 0;
    for (let i = 0; i < STAKES.length; i++) if (affordable(i)) best = i;
    return best;
  }

  function buildTicks() {
    const cells = STAKES.map((s, i) => {
      const cell = div('tick-cell');
      cell.dataset.index = String(i);
      const t = document.createElement('span');
      t.className = 'tick';
      cell.appendChild(t);
      return cell;
    });
    el.stakesSlider.replaceChildren(...cells);
  }

  /** dragX: finger position while dragging, for the fish-eye growth of nearby ticks. */
  function renderStakes(dragX) {
    const st = STAKES[stakeIdx];
    const ok = affordable(stakeIdx);
    el.stakesValue.textContent = `${fmtShort(st.ante)} / ${fmtShort(st.bb)}`;
    el.buyinValue.textContent = `${fmtShort(st.minBuyIn)} / ${fmtShort(st.maxBuyIn)}`;
    el.stakesNote.textContent = `Анте ${fmtAmt(st.ante)} · Мин. залог ${fmtAmt(st.bb)}`;
    screens.stakes.classList.toggle('unaffordable', !ok);
    el.btnStart.disabled = !ok;
    el.stakesSeat.textContent = ok
      ? `Сядаш с ${fmt(Math.min(st.maxBuyIn, P.bankroll))} чипа`
      : `Нужни са поне ${fmt(st.minBuyIn)} чипа · имаш ${fmt(P.bankroll)}`;
    el.stakesSlider.setAttribute('aria-valuenow', String(stakeIdx));
    el.stakesSlider.setAttribute('aria-valuetext', `${fmtShort(st.ante)} / ${fmtShort(st.bb)}`);
    const OPAC = [1, 0.55, 0.45, 0.35, 0.25, 0.15];
    const cells = el.stakesSlider.children;
    for (let i = 0; i < cells.length; i++) {
      const tick = cells[i].firstChild;
      const d = Math.abs(i - stakeIdx);
      tick.classList.toggle('active', i === stakeIdx);
      tick.classList.toggle('no', !affordable(i));
      tick.style.setProperty('--o', String(OPAC[Math.min(d, 5)]));
      if (dragX != null && i !== stakeIdx) {
        const r = cells[i].getBoundingClientRect();
        const near = Math.max(0, 1 - Math.abs(r.left + r.width / 2 - dragX) / 100);
        tick.style.height = `${Math.round(28 + 28 * near)}px`;
      } else {
        tick.style.height = '';
      }
    }
  }

  function pickStakeAt(x) {
    const r = el.stakesSlider.getBoundingClientRect();
    const i = Math.max(0, Math.min(STAKES.length - 1, Math.floor(((x - r.left) / r.width) * STAKES.length)));
    stakeIdx = i;
    lastStakeIdx = i;
    renderStakes(x);
  }

  function bindStakes() {
    const sl = el.stakesSlider;
    let dragging = false;
    sl.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { sl.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      sl.classList.add('dragging');
      pickStakeAt(e.clientX);
    });
    sl.addEventListener('pointermove', (e) => { if (dragging) pickStakeAt(e.clientX); });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      sl.classList.remove('dragging');
      renderStakes();
    };
    sl.addEventListener('pointerup', end);
    sl.addEventListener('pointercancel', end);
    sl.addEventListener('lostpointercapture', end);
    sl.addEventListener('keydown', (e) => {
      const keys = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, Home: -99, End: 99, PageDown: -1, PageUp: 1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      stakeIdx = Math.max(0, Math.min(STAKES.length - 1, stakeIdx + keys[e.key]));
      lastStakeIdx = stakeIdx;
      renderStakes();
    });
    el.btnStart.addEventListener('click', startGame);
    el.btnStakesBack.addEventListener('click', backHome);
  }

  async function startGame() {
    if (screenName !== 'stakes') return;
    const st = STAKES[stakeIdx];
    if (!affordable(stakeIdx)) return;
    const buyIn = Math.min(st.maxBuyIn, P.bankroll);
    P.bankroll -= buyIn;
    lastStakeIdx = stakeIdx;
    createTable(stakeIdx, buyIn);
    saveProfile();
    screenName = 'table';
    hideToast();
    countTo(el.stakesBankroll, P.bankroll, 300, { tone: true });
    screens.table.hidden = false;
    fitLabels(); // measured while the table was hidden: everything read as 0 wide
    await enterTable();
    if (screenName !== 'table') return;
    screens.stakes.hidden = true;
    screens.home.hidden = true;
    startLoop(150); // the entrance already gave the empty table its moment
  }

  /** The table arrives: it fades in, the seats drop in one by one on a spring, the deck slides up. */
  function enterTable() {
    const jobs = [anim(screens.table, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 })];
    if (still(500)) return jobs[0];
    T.seatEls.slice(1).forEach((se, i) => {
      jobs.push(anim(se.root, springFrames((v) => ({
        transform: `translateY(${(-28 * (1 - v)).toFixed(1)}px) scale(${mix(0.85, 1, v).toFixed(3)})`,
        opacity: clamp(v * 1.6, 0, 1),
      }), 0.6), { duration: 460, delay: 60 + i * 40, easing: 'linear', fill: 'backwards' }));
    });
    jobs.push(anim(el.deck, [{ transform: 'translateY(48px) scale(.9)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 420, delay: 140, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
    for (const node of [el.actions, el.handRow]) {
      jobs.push(anim(node, [{ transform: 'translateY(12px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 340, delay: 180, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
    }
    return Promise.all(jobs);
  }

  // ---------------------------------------------------------------------------------------------
  // Table state
  // ---------------------------------------------------------------------------------------------

  const T = {
    game: null,
    stake: null,
    token: 0, // bumping it stops the running game loop
    bots: {}, // playerId -> pool entry
    seatOf: {}, // playerId -> seat
    seatEls: [], // seat -> DOM refs (1..5)
    view: null, // what the screen shows (see header comment)
    hand: null, // per-hand bookkeeping for XP and the result
    waiting: null, // { kind: 'act' | 'next' | 'svara' | 'busted', resolve } while the loop waits for you
    actionMode: 'bet', // 'bet' | 'allin' | 'wait' | 'next'
    sessionXp: 0,
    svaras: 0,
    rig: null, // debug: cards for the next deal
    riffle: null, // the running shuffle (a promise) that the next deal waits for
    errors: 0,
  };
  let botSeq = 0;

  function makeBotPlayer(b) {
    const id = `bot-${b.key}-${++botSeq}`;
    T.bots[id] = b;
    return { id, name: b.name, avatar: b.avatar, stack: T.stake.maxBuyIn, personality: b.personality };
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Fresh shuffled deck, unless the debug hook rigged the next deal. */
  function deckProvider({ order }) {
    const deck = E.shuffle(E.newDeck(), Math.random);
    const rig = T.rig;
    if (!rig) return deck;
    T.rig = null;
    const used = new Set();
    for (const id of order) if (rig[id]) rig[id].forEach((c) => used.add(c));
    const rest = deck.filter((c) => !used.has(c.id));
    const out = [];
    for (const id of order) {
      if (rig[id]) out.push(...rig[id]);
      else out.push(rest.shift(), rest.shift(), rest.shift());
    }
    return out.concat(rest);
  }

  function createTable(idx, buyIn) {
    T.stake = STAKES[idx];
    T.bots = {};
    const players = [{ id: HUMAN_ID, name: HUMAN_NAME, avatar: HUMAN_AVATAR, stack: buyIn, isHuman: true }];
    shuffled(BOT_POOL).slice(0, SEATS - 1).forEach((b) => players.push(makeBotPlayer(b)));
    T.game = E.createGame({
      players, ante: T.stake.ante, bb: T.stake.bb,
      dealerIndex: Math.floor(Math.random() * SEATS), deckProvider,
    });
    T.sessionXp = 0;
    T.svaras = 0;
    T.hand = null;
    T.waiting = null;
    T.errors = 0;
    el.table.dataset.svaras = '0';
    el.table.dataset.hand = '0';
    el.table.dataset.turn = '0';
    el.tableXp.classList.remove('show');
    el.tableStakes.textContent = `${fmtShort(T.stake.ante)} / ${fmtShort(T.stake.bb)}`;
    el.infoBox.classList.remove('page-b');
    const s = T.game.getState();
    T.view = freshView(s);
    buildSeats();
    renderRoster(s.players);
    resetTableVisuals();
    setDealer(s.dealerIndex);
    T.actionMode = 'bet';
    refreshActions();
    setTimeout(() => { try { AI.equity(['Ah', 'Kh', 'Qh'], 1, { iterations: 1 }); } catch (e) { /* warm-up only */ } }, 0);
  }

  function freshView(s) {
    const V = { pot: 0, players: {}, svara: null };
    for (const p of s.players) {
      V.players[p.id] = { stack: p.stack, bet: 0, folded: false, allIn: false, inHand: p.stack > 0, cards: null, committed: 0 };
    }
    return V;
  }

  // ---------------------------------------------------------------------------------------------
  // Table rendering
  // ---------------------------------------------------------------------------------------------

  function buildSeats() {
    T.seatEls = [];
    const nodes = [];
    for (let seat = 1; seat < SEATS; seat++) {
      const root = div('seat');
      root.id = `seat-${seat}`;
      root.dataset.seat = String(seat);
      root.dataset.testid = `seat-${seat}`;
      root.innerHTML =
        '<div class="seat-marker"></div>' +
        '<div class="seat-body"><div class="seat-avatar"><span class="emoji"></span>' +
        '<span class="think" aria-hidden="true"><i class="r"><b></b></i><i class="l"><b></b></i></span>' +
        '<span class="dealer" hidden>D</span></div>' +
        '<div class="seat-name"></div><div class="seat-stack num"></div></div>' +
        '<div class="seat-label"></div><div class="seat-cards"></div>' +
        '<div class="seat-bet"><span class="bubble num" hidden></span></div>';
      T.seatEls[seat] = {
        root,
        avatar: root.querySelector('.emoji'),
        dealer: root.querySelector('.dealer'),
        name: root.querySelector('.seat-name'),
        stack: Object.assign(root.querySelector('.seat-stack'), { _fmt: fmtSeatStack }),
        label: root.querySelector('.seat-label'),
        cards: root.querySelector('.seat-cards'),
        bubble: root.querySelector('.bubble'),
        ring: Array.from(root.querySelectorAll('.think b')),
        ringAnims: [],
        labelTimer: 0,
      };
      nodes.push(root);
    }
    el.opps.replaceChildren(...nodes);
  }

  const seatEl = (id) => T.seatEls[T.seatOf[id]] || null;
  const stackEl = (id) => (id === HUMAN_ID ? el.infoStack : seatEl(id) && seatEl(id).stack);
  const bubbleEl = (id) => (id === HUMAN_ID ? el.heroBubble : seatEl(id) && seatEl(id).bubble);

  /** Names, avatars and stacks; a bot that just sat down pops in. */
  function renderRoster(players) {
    const bySeat = {};
    for (const p of players) {
      bySeat[p.seat] = p;
      T.seatOf[p.id] = p.seat;
    }
    for (let seat = 1; seat < SEATS; seat++) {
      const se = T.seatEls[seat];
      const p = bySeat[seat];
      se.root.classList.toggle('empty', !p);
      if (!p) { delete se.root.dataset.playerId; continue; }
      const fresh = se.root.dataset.playerId && se.root.dataset.playerId !== p.id;
      se.root.dataset.playerId = p.id;
      se.root.setAttribute('aria-label', p.name);
      se.avatar.textContent = p.avatar;
      se.name.textContent = p.name;
      stopCount(se.stack);
      setNum(se.stack, p.stack);
      if (fresh) anim(se.root, [{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
    }
    const me = players.find((p) => p.id === HUMAN_ID);
    el.infoAvatar.textContent = HUMAN_AVATAR;
    stopCount(el.infoStack);
    setNum(el.infoStack, me ? me.stack : 0);
  }

  function resetTableVisuals() {
    for (let seat = 1; seat < SEATS; seat++) {
      const se = T.seatEls[seat];
      if (!se) continue;
      clearTimeout(se.labelTimer);
      se.root.classList.remove('folded', 'out', 'won', 'lost', 'labeled', 'thinking', 'allin', 'tied');
      stopThinkRing(se);
      se.cards.replaceChildren();
      se.bubble.hidden = true;
    }
    el.hand.replaceChildren();
    el.hand.classList.remove('stacked');
    el.handRow.classList.remove('tied');
    el.infoBox.classList.remove('allin');
    el.heroBubble.hidden = true;
    el.pill.hidden = true;
    el.banner.hidden = true;
    el.banner.style.opacity = '';
    el.middle.classList.remove('svara');
    el.table.classList.remove('svara-dim');
    el.pot.classList.remove('celebrate');
    el.potLabel.textContent = 'Банка';
    stopCount(el.potAmount);
    setNum(el.potAmount, 0);
    el.table.dataset.result = '';
    el.infoHand.textContent = '';
    eqJob++; // odds still being computed belong to the old hand
    el.eqWin.textContent = '–';
    el.eqTie.textContent = '–';
  }

  function setDealer(seat) {
    for (let s = 1; s < SEATS; s++) {
      const se = T.seatEls[s];
      if (!se) continue;
      const on = s === seat;
      if (on && se.dealer.hidden) anim(se.dealer, [{ transform: 'scale(.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 160 });
      se.dealer.hidden = !on;
    }
    el.heroDealer.hidden = seat !== T.seatOf[HUMAN_ID];
  }

  /** The bet bubble: it pops in on a spring when it appears and pulses when the bet grows. */
  function showBubble(id, amount, { pulse = false, ring = false } = {}) {
    const b = bubbleEl(id);
    if (!b) return;
    const wasHidden = b.hidden;
    b.textContent = fmtAmt(amount);
    b.hidden = false;
    if (wasHidden) popIn(b);
    else if (pulse) {
      anim(b, [
        { transform: 'none' }, { transform: 'scale(1.22)', offset: 0.3 }, { transform: 'scale(.96)', offset: 0.65 }, { transform: 'none' },
      ], { duration: 340, easing: 'ease-out' });
    }
    if (ring) ringBurst(rectOf(b), { cls: 'ring-bet', from: 1, to: [1.45, 1.9], duration: 480 });
  }

  /*
   * A bet: 1–3 chips are tossed from the avatar to the bet spot, then the bubble shows the new
   * total (a new bubble pops in, a raised one pulses with a ring). The view model is already
   * updated; only the picture waits for the chips. It runs in three steps, so that several bets
   * (the antes) write, then measure, then animate, with a single layout in between.
   */

  /** Step 1, writes only: a new bubble is laid out (to aim at) but stays invisible. */
  function readyBet(id, total) {
    const b = bubbleEl(id);
    if (!b) return null;
    const fresh = b.hidden;
    if (fresh) {
      b.textContent = fmtAmt(total);
      b.hidden = false;
      b.style.opacity = '0';
    }
    return { id, b, total, fresh };
  }

  /** Step 2, reads only. */
  function aimBet(bet) {
    bet.from = avatarRect(bet.id);
    bet.to = rectOf(bet.b);
    return bet;
  }

  /** Step 3: the chips fly, then the bubble shows the total. */
  async function throwBet(bet, added, { raise = false, delay = 0 } = {}) {
    await tossChips(bet.from, bet.to, chipCount(added), delay);
    bet.b.style.opacity = '';
    if (bet.b.hidden) return; // swept away meanwhile
    if (bet.fresh) popIn(bet.b);
    showBubble(bet.id, bet.total, { pulse: !bet.fresh, ring: raise });
  }

  async function placeBet(id, total, added, opts) {
    const bet = readyBet(id, total);
    if (bet) await throwBet(aimBet(bet), added, opts);
  }

  function hideBubble(id) {
    const b = bubbleEl(id);
    if (b) b.hidden = true;
  }

  /** The last action over a bot's avatar; `slam` drops it in from big (all-in). */
  function showLabel(id, text, ms = 650, slam = false) {
    const se = seatEl(id);
    if (!se) return;
    se.label.textContent = text;
    se.root.classList.add('labeled');
    clearTimeout(se.labelTimer);
    se.labelTimer = setTimeout(() => se.root.classList.remove('labeled'), dur(ms));
    if (slam) {
      anim(se.label, [
        { transform: 'scale(2.3)', opacity: 0 },
        { transform: 'scale(.92)', opacity: 1, offset: 0.6 },
        { transform: 'scale(1.04)', offset: 0.8 },
        { transform: 'none', opacity: 1 },
      ], { duration: 300, easing: 'cubic-bezier(.5,0,.6,1)' });
    }
  }

  function labelFor(a) {
    switch (a.type) {
      case 'fold': return 'Пас';
      case 'check': return 'Чек';
      case 'call': return 'Плаща';
      case 'raise': return a.isBet ? 'Залага' : 'Вдига';
      case 'allin': return 'Ва банк';
      default: return '';
    }
  }

  /** Paint a card face. kind: 'big' (your hand: the front face of a two-faced card) or 'mini'. */
  function paintFace(node, card, kind) {
    const c = typeof card === 'string' ? E.parseCard(card) : card;
    const face = (kind === 'big' && node.querySelector('.front')) || node;
    node.classList.remove('back', 'down');
    node.classList.toggle('red', !!RED[c.suit]);
    node.dataset.card = c.id;
    node.setAttribute('aria-label', c.id);
    const r = document.createElement('span');
    r.className = 'r' + (c.rank === '10' ? ' ten' : '');
    r.textContent = c.rank;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = SUIT[c.suit];
    face.replaceChildren(r, s);
    if (kind === 'big' && E.isJoker(c, true)) {
      const j = document.createElement('span');
      j.className = 'jk';
      j.title = 'Шпока';
      j.textContent = '★';
      face.appendChild(j);
    }
  }

  /**
   * Empty, invisible card slots for a deal. Yours are two-faced (front + back in a 3D flipper)
   * and face down; a mini is a single element showing its back.
   */
  function makeSlots(id) {
    const hero = id === HUMAN_ID;
    const nodes = [0, 1, 2].map((i) => {
      const n = div(hero ? 'card down' : 'mini back');
      if (hero) {
        n.style.setProperty('--i', String(i));
        n.innerHTML = '<div class="card-flip"><div class="face front"></div><div class="face back"></div></div>';
      }
      n.style.opacity = '0';
      return n;
    });
    if (id === HUMAN_ID) el.hand.replaceChildren(...nodes);
    else if (seatEl(id)) seatEl(id).cards.replaceChildren(...nodes);
    return nodes;
  }

  const heroCards = () => Array.from(el.hand.children);
  const miniCards = (id) => (seatEl(id) ? Array.from(seatEl(id).cards.children) : []);

  function setSeatState(id) {
    const v = T.view.players[id];
    if (!v) return;
    const allIn = v.inHand && !v.folded && v.allIn;
    if (id === HUMAN_ID) {
      el.infoBox.classList.toggle('allin', allIn);
      return;
    }
    const se = seatEl(id);
    if (!se) return;
    se.root.classList.toggle('out', !v.inHand);
    se.root.classList.toggle('folded', v.inHand && v.folded);
    se.root.classList.toggle('allin', allIn);
  }

  /** Svara: the tied players glow gold above the vignette. */
  function markTied(id, on) {
    if (id === HUMAN_ID) el.handRow.classList.toggle('tied', on);
    else if (seatEl(id)) seatEl(id).root.classList.toggle('tied', on);
  }

  /** The thinking bot: a thin ring sweeps once around its avatar over the think time (ms). */
  function startThinkRing(se, ms) {
    stopThinkRing(se);
    if (still(ms) || typeof se.ring[0].animate !== 'function') return;
    const half = [{ transform: 'rotate(45deg)' }, { transform: 'rotate(225deg)' }];
    const timing = { duration: dur(ms), easing: 'linear', fill: 'forwards' };
    try {
      se.ringAnims = [
        se.ring[0].animate([half[0], { ...half[1], offset: 0.5 }, half[1]], timing), // right half first
        se.ring[1].animate([half[0], { ...half[0], offset: 0.5 }, half[1]], timing), // then the left half
      ];
    } catch (e) {
      se.ringAnims = [];
    }
  }

  function stopThinkRing(se) {
    se.ringAnims.forEach((a) => a.cancel());
    se.ringAnims = [];
  }

  /** "21 точки" + win/svara odds against the opponents still in. */
  function updateInfoBox() {
    const v = T.view && T.view.players[HUMAN_ID];
    const cards = v && v.inHand && v.cards;
    el.infoHand.textContent = cards ? E.scoreHand(cards).label : '';
    updateEquity();
  }

  /**
   * 2 000 Monte Carlo deals, run as four slices of 500 in separate tasks so that no animation
   * frame waits for them (the average of equal slices is the same estimate). A newer request,
   * or a new hand, drops the slices still pending.
   */
  const EQ_SLICES = 4;
  let eqJob = 0;
  function updateEquity() {
    const job = ++eqJob;
    const v = T.view && T.view.players[HUMAN_ID];
    if (!v || !v.inHand || !v.cards || v.folded) {
      el.eqWin.textContent = '–';
      el.eqTie.textContent = '–';
      return;
    }
    const cards = v.cards.slice();
    const n = Object.entries(T.view.players).filter(([id, q]) => id !== HUMAN_ID && q.inHand && !q.folded).length;
    let win = 0;
    let tie = 0;
    let done = 0;
    const slice = () => {
      if (job !== eqJob) return;
      const eq = AI.equity(cards, n, { iterations: 2000 / EQ_SLICES });
      win += eq.win;
      tie += eq.tie;
      if (++done < EQ_SLICES) {
        setTimeout(slice, 0);
        return;
      }
      el.eqWin.textContent = pct(win / EQ_SLICES);
      el.eqTie.textContent = pct(tie / EQ_SLICES);
    };
    setTimeout(slice, 0);
  }

  function showSessionXp() {
    el.tableXpValue.textContent = `+${fmt(T.sessionXp)} XP`;
    if (!el.tableXp.classList.contains('show')) el.tableXp.classList.add('show');
    else anim(el.tableXp, [{ transform: 'translateY(-3px)' }, { transform: 'none' }], { duration: 220 });
  }

  // --- flights and overlay effects -------------------------------------------------------------

  function rectOf(node) {
    const r = node && node.getBoundingClientRect();
    return r && r.width > 0 ? r : null;
  }

  function potRect() {
    return rectOf(el.potAmount) || rectOf(el.deckTop) || rectOf(el.middle);
  }

  /** A player's avatar: the seat's, or yours in the info box. */
  function avatarNode(id) {
    if (id === HUMAN_ID) return el.infoAvatar.parentNode;
    const se = seatEl(id);
    return se ? se.avatar.parentNode : null;
  }

  /** The middle of a player's bet spot (empty after the sweep): under the seat, or your lane. */
  function betSpot(id) {
    const b = bubbleEl(id);
    const r = b && b.parentNode.getBoundingClientRect(); // an empty spot is 0 wide but in place
    if (!r || !r.height) return null;
    const h = b.offsetHeight || r.height;
    return id === HUMAN_ID ? { x: r.left + 10 + h, y: r.top + h / 2 } : { x: r.left + r.width / 2, y: r.top + h / 2 };
  }

  /** Where a player's chips come from and go to (the whole info box while it shows the odds). */
  function avatarRect(id) {
    if (id === HUMAN_ID && el.infoBox.classList.contains('page-b')) return rectOf(el.infoBox);
    return rectOf(avatarNode(id));
  }

  /** A node in the fx overlay (viewport coordinates), placed by transforms only. */
  function fxNode(cls, w, h, text) {
    const n = div(`fly ${cls}`, text);
    if (w) n.style.width = `${w}px`;
    if (h) n.style.height = `${h}px`;
    el.fx.appendChild(n);
    return n;
  }

  /** Transform that centres a w×h overlay box on point c, plus `extra` transform functions. */
  const placeAt = (c, w, h, extra = '') => `translate(${(c.x - w / 2).toFixed(1)}px, ${(c.y - h / 2).toFixed(1)}px)${extra}`;
  const pair = (v) => (Array.isArray(v) ? v : [v, v]);

  // Deal timing: one card every DEAL.gap ms, DEAL.fly ms in the air.
  const DEAL = { fly: 250, gap: 22 };

  /**
   * A card back flies from rect `from` to rect `to` along an arc: it spins down to 0°, grows a
   * little at the top of the arc and has a soft shadow under it. Opponent cards are built at deck
   * size (the deck's own back) and shrink on the way; your cards are built at their own size.
   */
  function flyCard(from, to, { delay = 0, tiny = false, spin = 0, bend = 0.12 } = {}) {
    const base = tiny ? from : to;
    const w = base.width;
    const h = base.height;
    const f = fxNode(tiny ? 'fly-card' : 'fly-card big', w, h);
    f.style.borderRadius = `${(w * (tiny ? 0.18 : 0.2)).toFixed(1)}px`;
    f.innerHTML = '<i class="fly-shadow"></i><i class="fly-face back"></i>';
    const a = center(from);
    const b = center(to);
    const frames = arcFrames(a, b, bowCtrl(a, b, outward(a, b, bend)), {
      w, h, s0: [from.width / w, from.height / h], s1: [to.width / w, to.height / h], lift: 0.1, spin, steps: 10,
    });
    const timing = { duration: DEAL.fly, delay, easing: 'cubic-bezier(.3,.6,.25,1)', fill: 'both' };
    anim(f.firstChild, [
      { opacity: 0.2, transform: 'translateY(2%)' },
      { opacity: 0.6, transform: 'translateY(12%) scale(1.06)', offset: 0.45 },
      { opacity: 0, transform: 'translateY(1%)' },
    ], timing);
    return anim(f, frames, timing).then(() => f.remove());
  }

  /** The top of the deck gives a little towards each card as it leaves (one animation per deal). */
  function kickDeck(dirs) {
    if (!dirs.length) return;
    const total = DEAL.gap * dirs.length + 90;
    const frames = [];
    dirs.forEach((dir, k) => {
      const at = DEAL.gap * k;
      frames.push({ offset: at / total, transform: 'none' });
      frames.push({ offset: (at + DEAL.gap * 0.6) / total, transform: `translate(${dir * 2}px, -1.5px) rotate(${dir * 1.5}deg)` });
    });
    frames.push({ offset: 1, transform: 'none' });
    anim(el.deckTop, frames, { duration: total, easing: 'linear' });
  }

  /** The deck splits into two halves that riffle back together (~450 ms). */
  function riffle() {
    if (still(450, el.deck)) return Promise.resolve();
    const box = div('riffle');
    const cards = [];
    for (let k = 0; k < 8; k++) {
      const c = div('riffle-card back');
      c.style.zIndex = String(k + 1); // the order they fall back in: left, right, left, …
      cards.push(c);
    }
    box.append(...cards);
    el.deck.appendChild(box);
    el.deck.classList.add('riffling');
    const jobs = cards.map((c, k) => {
      const side = k % 2 ? 1 : -1;
      const j = k >> 1; // height within its half
      const split = `translate(${side * 60}%, ${(-3 - j * 1.6).toFixed(1)}px) rotate(${side * 9}deg)`; // % of the card's own width
      const fall = 0.4 + k * 0.055;
      return anim(c, [
        { offset: 0, transform: 'none', easing: 'cubic-bezier(.2,.8,.3,1)' },
        { offset: 0.28, transform: split },
        { offset: fall, transform: split, easing: 'cubic-bezier(.5,0,.75,.5)' },
        { offset: fall + 0.1, transform: `translate(0px, ${(-k * 0.4).toFixed(1)}px) rotate(${side * 1.5}deg)`, easing: 'ease-out' },
        { offset: 1, transform: 'none' },
      ], { duration: 450, easing: 'linear' });
    });
    return Promise.all(jobs).then(() => {
      box.remove();
      el.deck.classList.remove('riffling');
    });
  }

  /** A copy of a card on the table as it looks now, in the overlay, for flying it somewhere. */
  function ghostOf(node, r) {
    const g = fxNode('ghost', r.width, r.height);
    // the size variables of the table, which the card's own rules use
    g.style.setProperty('--card-w', `${r.width}px`);
    g.style.setProperty('--card-h', `${r.height}px`);
    g.style.setProperty('--mini-w', `${r.width}px`);
    const c = node.cloneNode(true);
    c.classList.remove('hot');
    c.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;opacity:1;transform:none';
    g.appendChild(c);
    return g;
  }

  /** Every card on the table flies back into the deck (a svara starts), one after another. */
  async function returnCards(nodes) {
    const to = rectOf(el.deckTop);
    const rects = nodes.map(rectOf); // measure everything before touching the DOM
    if (!to || still(300)) {
      await Promise.all(nodes.map((n) => anim(n, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' })));
      nodes.forEach((n) => n.remove());
      return;
    }
    const gap = Math.min(28, 220 / nodes.length);
    const b = center(to);
    const flights = nodes.map((n, i) => {
      const r = rects[i];
      n.style.opacity = '0';
      if (!r) return null;
      const g = ghostOf(n, r);
      const a = center(r);
      const shrink = n.classList.contains('mini') ? 0.6 : 1; // a mini scaled up to deck size would blur
      const frames = arcFrames(a, b, bowCtrl(a, b, outward(a, b, 0.16)), {
        w: r.width, h: r.height, s1: [(to.width / r.width) * shrink, (to.height / r.height) * shrink],
        turn: rand(-25, 25), opacity: (t) => (t < 0.8 ? 1 : (1 - t) / 0.2),
      });
      return anim(g, frames, { duration: 300, delay: i * gap, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'both' }).then(() => g.remove());
    });
    await Promise.all(flights);
    nodes.forEach((n) => n.remove());
  }

  /** A bet bubble arcs into the pot, shrinking and fading as it arrives. */
  function flyBubble(b, r, to, delay) {
    if (!r || !to || still(300)) return Promise.resolve();
    const f = b.cloneNode(true);
    f.removeAttribute('id');
    f.hidden = false;
    f.style.cssText = `width:${r.width}px;height:${r.height}px;min-width:0`;
    f.classList.add('fly', 'fly-chip');
    el.fx.appendChild(f);
    const a = center(r);
    const c = center(to);
    const frames = arcFrames(a, c, bowCtrl(a, c, (c.x - a.x) * (c.y - a.y) > 0 ? 0.2 : -0.2), {
      w: r.width, h: r.height, s1: [0.45, 0.45], opacity: (t) => (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3),
    });
    return anim(f, frames, { duration: 300, delay, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'both' }).then(() => f.remove());
  }

  /** 1–3 stacked chips, by the size of the bet. */
  const chipCount = (amount) => (amount <= T.stake.bb ? 1 : amount <= 4 * T.stake.bb ? 2 : 3);

  /** Chips are tossed from the avatar onto the bet spot in a small arc. */
  function tossChips(from, to, n, delay = 0) {
    if (!from || !to || still(280)) return Promise.resolve();
    const size = 14;
    const f = fxNode('chips', size, size);
    for (let i = 0; i < n; i++) {
      const c = document.createElement('i');
      c.className = 'chip';
      c.style.transform = `translateY(${-i * 2.5}px)`;
      f.appendChild(c);
    }
    const a = center(from);
    const b = center(to);
    const frames = arcFrames(a, b, hopCtrl(a, b, 24), {
      w: size, h: size, s0: [0.7, 0.7], lift: 0.25, opacity: (t) => Math.min(1, t / 0.12, (1 - t) / 0.12),
    });
    return anim(f, frames, { duration: 280, delay, easing: 'cubic-bezier(.3,.5,.4,1)', fill: 'both' }).then(() => f.remove());
  }

  /** An expanding ring over a box: a win, a raise, the svara shockwave. */
  function ringBurst(r, { cls = '', from = 0.6, to = 2, duration = 600, delay = 0 } = {}) {
    if (!r || still(duration)) return Promise.resolve();
    const n = fxNode(`burst ${cls}`, r.width, r.height);
    const c = center(r);
    const [fx, fy] = pair(from);
    const [tx, ty] = pair(to);
    return anim(n, [
      { transform: placeAt(c, r.width, r.height, ` scale(${fx}, ${fy})`), opacity: 0.9 },
      { transform: placeAt(c, r.width, r.height, ` scale(${tx}, ${ty})`), opacity: 0 },
    ], { duration, delay, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'both' }).then(() => n.remove());
  }

  /** Text that rises a little and fades: "+N" over a stack, "Печелиш +N" over the pot. */
  function floatText(text, c, { cls = '', rise = 24, duration = 900, delay = 0 } = {}) {
    if (still(duration)) return Promise.resolve(); // with reduced motion it would only blink
    const n = fxNode(`float ${cls}`, 0, 0, text);
    const w = n.offsetWidth;
    const h = n.offsetHeight;
    n.style.transform = placeAt(c, w, h);
    n.style.opacity = '0';
    return anim(n, [
      { transform: placeAt(c, w, h, ' translateY(6px) scale(.9)'), opacity: 0 },
      { transform: placeAt(c, w, h), opacity: 1, offset: 0.16 },
      { transform: placeAt(c, w, h, ` translateY(${(-rise * 0.75).toFixed(1)}px)`), opacity: 1, offset: 0.72 },
      { transform: placeAt(c, w, h, ` translateY(${-rise}px)`), opacity: 0 },
    ], { duration, delay, easing: 'cubic-bezier(.2,.6,.3,1)', fill: 'both' }).then(() => n.remove());
  }

  /**
   * Shared-element morph: a box with fill A grows (or shrinks) from rect a into rect b while it
   * cross-fades into fill B. Corners are [tl, tr, br, bl] px as seen on screen. Resolves with the
   * overlay node, which the caller fades out once the real element is in place underneath.
   */
  function morph(a, b, { fillA, fillB, cornersA, cornersB, duration = 380 }) {
    const g = fxNode('morph', b.width, b.height);
    g.innerHTML = '<i></i><i></i>';
    const [la, lb] = g.children;
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    // A's corners are drawn in the scaled box, so they are divided by the starting scale.
    const ell = (c, kx, ky) => `${c.map((v) => `${(v / kx).toFixed(1)}px`).join(' ')} / ${c.map((v) => `${(v / ky).toFixed(1)}px`).join(' ')}`;
    la.style.background = fillA;
    la.style.borderRadius = ell(cornersA, sx, sy);
    lb.style.background = fillB;
    lb.style.borderRadius = ell(cornersB, 1, 1);
    anim(la, [{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.7, easing: 'ease-in', fill: 'both' });
    anim(lb, [{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.6, easing: 'ease-out', fill: 'both' });
    return anim(g, [
      { transform: placeAt(center(a), b.width, b.height, ` scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`) },
      { transform: placeAt(center(b), b.width, b.height) },
    ], { duration, easing: 'cubic-bezier(.3,.7,.15,1)', fill: 'both' }).then(() => g);
  }

  /** Fade an overlay node out and drop it. */
  function dropFx(node, ms = 120) {
    return anim(node, [{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: 'forwards' }).then(() => node.remove());
  }

  // --- particles: one canvas over the app ---------------------------------------------------------
  // The canvas is hidden (and has no backing store) while nothing flies, and the frame loop runs
  // only while there are particles. Particles are parametric in their own progress, so SPEED only
  // stretches their lifetime.

  const TAU = Math.PI * 2;

  /** Position after tau base seconds of a throw with linear air drag and gravity. */
  function ballistic(p, tau) {
    const e = (1 - Math.exp(-p.drag * tau)) / p.drag;
    const vt = p.g / p.drag;
    return [p.x + p.vx * e, p.y + (p.vy - vt) * e + vt * tau];
  }

  const DRAW = {
    /** A chip on a curve with a short fading trail. */
    chip(ctx, p, k, colors) {
      const at = (q) => {
        const e = easeInOut(clamp(q, 0, 1));
        const u = 1 - e;
        return [u * u * p.a.x + 2 * u * e * p.c.x + e * e * p.b.x, u * u * p.a.y + 2 * u * e * p.c.y + e * e * p.b.y];
      };
      const fade = Math.min(1, k / 0.1, (1 - k) / 0.12);
      ctx.fillStyle = colors.chip;
      for (let i = 4; i >= 1; i--) {
        const q = k - i * 0.035;
        if (q <= 0) continue;
        const [x, y] = at(q);
        ctx.globalAlpha = fade * 0.3 * (1 - i / 5);
        ctx.beginPath();
        ctx.arc(x, y, p.r * (1 - i * 0.13), 0, TAU);
        ctx.fill();
      }
      const [x, y] = at(k);
      ctx.globalAlpha = fade;
      ctx.fillStyle = colors.chipEdge;
      ctx.beginPath();
      ctx.arc(x, y, p.r, 0, TAU);
      ctx.fill();
      ctx.fillStyle = colors.chip;
      ctx.beginPath();
      ctx.arc(x, y, p.r * 0.7, 0, TAU);
      ctx.fill();
    },
    /** Confetti: a bit of paper tossed up, slowed by the air, fluttering as it falls. */
    confetti(ctx, p, k) {
      const tau = k * p.base;
      const [x, y] = ballistic(p, tau);
      const flutter = Math.abs(Math.cos(p.flutter * tau + p.phase));
      ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.rot + p.spin * tau);
      ctx.fillRect(-p.w / 2, (-p.h / 2) * flutter, p.w, p.h * flutter);
      ctx.restore();
    },
    /** A spark: a bright dot with a soft halo that slows down and fades. */
    spark(ctx, p, k) {
      const [x, y] = ballistic(p, k * p.base);
      const a = Math.pow(1 - k, 1.5);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = a * 0.28;
      ctx.beginPath();
      ctx.arc(x, y, p.r * 2.6, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x, y, p.r, 0, TAU);
      ctx.fill();
    },
  };

  const FX = {
    canvas: null,
    ctx: null,
    dpr: 1,
    w: 0,
    h: 0,
    raf: 0,
    parts: [],
    colors: null,

    init(canvas) {
      this.canvas = canvas;
      try {
        this.ctx = canvas.getContext('2d');
      } catch (e) {
        this.ctx = null; // no canvas: no particles
      }
    },

    /** Particles are skipped with reduced motion, without a canvas, and when they would flash by. */
    ok(ms) {
      return !!this.ctx && !reduced() && dur(ms) >= 80;
    },

    /** Match the viewport at the device pixel ratio (capped at 2: soft particles need no more). */
    resize() {
      if (!this.ctx || this.canvas.hidden) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      Object.assign(this, { w, h, dpr });
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    },

    /** Particle colours come from the CSS tokens. */
    palette() {
      if (!this.colors) {
        const cs = getComputedStyle(document.documentElement);
        const v = (name) => cs.getPropertyValue(name).trim();
        this.colors = {
          chip: v('--chip'),
          chipEdge: v('--chip-edge'),
          gold: [v('--confetti-1'), v('--confetti-2'), v('--confetti-3'), v('--confetti-4')],
          spark: [v('--spark'), v('--win-gold'), v('--confetti-3')],
        };
      }
      return this.colors;
    },

    add(list) {
      if (!this.ctx || !list.length) return;
      this.parts.push(...list);
      if (this.raf) return;
      this.canvas.hidden = false;
      this.resize();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    },

    frame(now) {
      const { ctx } = this;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      const colors = this.palette();
      this.parts = this.parts.filter((p) => now - p.t0 < p.life);
      for (const p of this.parts) {
        const k = (now - p.t0) / p.life;
        if (k >= 0) DRAW[p.kind](ctx, p, k, colors);
      }
      ctx.globalAlpha = 1;
      if (this.parts.length) this.raf = requestAnimationFrame((t) => this.frame(t));
      else this.clear();
    },

    clear() {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.parts = [];
      if (!this.ctx) return;
      this.canvas.hidden = true;
      this.canvas.width = 0; // free the backing store; the next burst sizes it again
      this.canvas.height = 0;
      this.w = 0;
      this.h = 0;
    },
  };

  /**
   * The pot streams to a winner as n chips on slightly different curves, one after another.
   * Returns the base ms until the first chip lands (0 without particles).
   */
  function chipStream(from, to, n, delay = 0) {
    const life = 460;
    if (!from || !to || !FX.ok(life)) return 0;
    const a = center(from);
    const b = center(to);
    const t0 = performance.now();
    const parts = [];
    for (let i = 0; i < n; i++) {
      const s = { x: a.x + rand(-12, 12), y: a.y + rand(-6, 6) };
      const e = { x: b.x + rand(-5, 5), y: b.y + rand(-4, 4) };
      parts.push({ kind: 'chip', t0: t0 + dur(delay + i * 40), life: dur(life), a: s, b: e, c: bowCtrl(s, e, rand(-0.3, 0.3)), r: rand(4.2, 5.6) });
    }
    FX.add(parts);
    return delay + life;
  }

  /** Light gold confetti thrown up from a point (you won). */
  function confetti(c, n = 64) {
    if (!FX.ok(1200)) return;
    const { gold } = FX.palette();
    const t0 = performance.now();
    const parts = [];
    for (let i = 0; i < n; i++) {
      const ang = rand(-Math.PI * 0.95, -Math.PI * 0.05);
      const sp = rand(240, 700);
      parts.push({
        kind: 'confetti', t0: t0 + dur(rand(0, 90)), life: dur(1200), base: 1.2,
        x: c.x + rand(-16, 16), y: c.y + rand(-6, 6), vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, drag: 2.4, g: 900,
        w: rand(4, 7), h: rand(7, 11), rot: rand(0, TAU), spin: rand(-9, 9), flutter: rand(8, 16), phase: rand(0, TAU), color: pick(gold),
      });
    }
    FX.add(parts);
  }

  /** Gold sparks bursting out of a point (three 7s, three aces). */
  function sparks(c, n, power = 1) {
    if (!FX.ok(1100)) return;
    const { spark } = FX.palette();
    const t0 = performance.now();
    const parts = [];
    for (let i = 0; i < n; i++) {
      const ang = rand(0, TAU);
      const sp = rand(110, 400) * power;
      const base = rand(0.8, 1.1);
      parts.push({
        kind: 'spark', t0: t0 + dur(rand(0, 60)), life: dur(base * 1000), base,
        x: c.x, y: c.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 60, drag: 3.2, g: 260, r: rand(1.2, 2.4), color: pick(spark),
      });
    }
    FX.add(parts);
  }

  /** Three 7s (34) or three aces (33). */
  const isMonster = (s) => !!s && (s.kind === 'three7' || (s.kind === 'trips' && s.points === 33));

  /** A monster hand: a gold band sweeps over its cards twice and sparks fly out of them. */
  function monsterFx(nodes, big) {
    if (reduced()) return;
    const rects = nodes.map(rectOf).filter(Boolean);
    const sweep = [{ transform: 'translateX(-130%) skewX(-18deg)', opacity: 1 }, { transform: 'translateX(260%) skewX(-18deg)', opacity: 1 }];
    nodes.forEach((n, i) => {
      const host = big ? n.querySelector('.front') : n;
      if (!host || still(650, host)) return;
      const band = document.createElement('i');
      band.className = 'shimmer';
      host.appendChild(band);
      anim(band, sweep, { duration: 650, delay: 70 * i, easing: 'cubic-bezier(.4,0,.2,1)' })
        .then(() => anim(band, sweep, { duration: 650, delay: 120, easing: 'cubic-bezier(.4,0,.2,1)' }))
        .then(() => band.remove());
    });
    if (!rects.length) return;
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    sparks({ x: (left + right) / 2, y: (top + bottom) / 2 }, big ? 72 : 56, big ? 1.25 : 1);
  }

  // ---------------------------------------------------------------------------------------------
  // Event playback
  // ---------------------------------------------------------------------------------------------

  const alive = (token) => token === T.token && !!T.game;

  /** Cards for a deal: a later showdown in the same batch is authoritative (see header). */
  function dealSource(events, i) {
    for (let j = i + 1; j < events.length; j++) {
      const t = events[j].type;
      if (t === 'showdown') return events[j].cards;
      if (t === 'svara-start' || t === 'hand-start' || t === 'turn') break;
    }
    return null;
  }

  async function playEvents(events, pre, token) {
    for (let i = 0; i < events.length; i++) {
      if (!alive(token)) return;
      const ev = events[i];
      switch (ev.type) {
        case 'hand-start':
          playHandStart(ev, pre);
          break;
        case 'ante': {
          const group = [ev];
          while (events[i + 1] && events[i + 1].type === 'ante') group.push(events[++i]);
          await playAntes(group, token);
          break;
        }
        case 'deal': {
          const group = [ev];
          while (events[i + 1] && events[i + 1].type === 'deal') group.push(events[++i]);
          await playDeal(group, dealSource(events, i), token);
          break;
        }
        case 'turn':
          refreshActions();
          break;
        case 'action':
          await playAction(ev);
          break;
        case 'round-end':
          await sweepBets(ev.pot, token);
          break;
        case 'showdown': {
          const wins = [];
          while (events[i + 1] && events[i + 1].type === 'win') wins.push(events[++i]);
          const sv = events[i + 1] && events[i + 1].type === 'svara' ? events[i + 1] : null;
          await playShowdown(ev, wins, sv, token);
          break;
        }
        case 'win': {
          const wins = [ev];
          while (events[i + 1] && events[i + 1].type === 'win') wins.push(events[++i]);
          await playWins(wins, null);
          break;
        }
        case 'svara':
          await playSvara(ev);
          break;
        case 'svara-join':
        case 'svara-decline':
          await playSvaraDecision(ev);
          break;
        case 'svara-start':
          await playSvaraStart(ev, token);
          break;
        case 'hand-over':
          playHandOver();
          break;
        default:
          break;
      }
    }
  }

  function playHandStart(ev, pre) {
    T.hand = { number: ev.handNumber, humanDealt: false, humanPots: 0, humanWon: 0, result: '' };
    T.view = freshView(pre);
    T.seatOf = {};
    renderRoster(pre.players);
    resetTableVisuals();
    for (const p of pre.players) if (p.id !== HUMAN_ID) setSeatState(p.id);
    setDealer(ev.dealerIndex);
    el.table.dataset.hand = String(ev.handNumber);
    const me = T.view.players[HUMAN_ID];
    T.actionMode = me && me.inHand ? 'bet' : 'wait';
    refreshActions();
    T.riffle = riffle(); // the deck shuffles while the antes go in; the deal waits for it
  }

  async function playAntes(group, token) {
    let total = T.view.pot;
    for (const ev of group) {
      const v = T.view.players[ev.playerId];
      v.stack -= ev.amount;
      v.committed += ev.amount;
      v.bet = ev.amount; // shown in the bubble until the sweep (antes are not part of roundBet)
      if (ev.allIn) v.allIn = true;
      total += ev.amount;
      countTo(stackEl(ev.playerId), v.stack, 450);
      setSeatState(ev.playerId);
    }
    const me = T.view.players[HUMAN_ID];
    if (me && me.inHand && me.allIn) { T.actionMode = 'allin'; refreshActions(); }
    // everyone throws in an ante, one after another: all writes, then all reads, then the flights
    const bets = group.map((ev) => readyBet(ev.playerId, ev.amount));
    bets.forEach((bet) => bet && aimBet(bet));
    await Promise.all(bets.map((bet, k) => bet && throwBet(bet, bet.total, { delay: 30 * k })));
    await sleep(180);
    if (!alive(token)) return;
    await sweepBets(total, token, 0); // the pot counts up while the deal starts
  }

  async function playDeal(group, src, token) {
    const ids = group.map((e) => e.playerId);
    const state = T.game.getState();
    for (const id of ids) {
      const v = T.view.players[id];
      v.inHand = true;
      if (id === HUMAN_ID) {
        const mine = (src && src[HUMAN_ID]) || state.players.find((p) => p.id === HUMAN_ID).cards;
        v.cards = mine.map((c) => E.parseCard(c.id));
        T.hand.humanDealt = true;
      }
    }
    if (T.riffle) await T.riffle; // the shuffle ends before the first card leaves
    T.riffle = null;
    if (!alive(token)) return;
    const slots = {};
    for (const id of ids) slots[id] = makeSlots(id);
    const heroIn = ids.includes(HUMAN_ID);
    if (heroIn) el.hand.classList.add('stacked'); // your cards land as a pile and fan out after the flip
    const from = rectOf(el.deckTop);
    if (from && !still(DEAL.fly)) {
      // round robin from the left of the dealer (the engine's order), one card every DEAL.gap ms
      const plan = [];
      for (let round = 0; round < 3; round++) for (const id of ids) plan.push({ id, node: slots[id][round] });
      plan.forEach((p) => { p.to = rectOf(p.node); }); // measure every slot before adding flights
      const deck = center(from);
      const jobs = [];
      let heroLanded = null;
      kickDeck(plan.map((p) => (p.to && center(p.to).x < deck.x ? -1 : 1)));
      plan.forEach((p, k) => {
        if (!p.to) { p.node.style.opacity = ''; return; }
        const delay = DEAL.gap * k;
        const side = center(p.to).x < deck.x ? -1 : 1;
        const landed = flyCard(from, p.to, { delay, tiny: p.id !== HUMAN_ID, spin: side * rand(25, 50) })
          .then(() => { p.node.style.opacity = ''; });
        if (p.id === HUMAN_ID) heroLanded = landed; // the last one: your third card
        jobs.push(landed);
      });
      if (heroIn) jobs.push(Promise.resolve(heroLanded).then(() => (alive(token) ? revealHand(slots[HUMAN_ID]) : null)));
      await Promise.all(jobs);
    } else {
      for (const id of ids) slots[id].forEach((n) => { n.style.opacity = ''; });
      if (heroIn) await revealHand(slots[HUMAN_ID]);
    }
    if (!alive(token)) return;
    if (heroIn) {
      updateInfoBox();
      anim(el.infoHand, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    } else {
      updateEquity();
    }
  }

  /**
   * Your cards, dealt as a face-down pile: the pile turns over in one real 3D flip (perspective,
   * rotateY, back faces hidden, lifting towards you), then the cards fan out on the CSS spring.
   */
  async function revealHand(nodes) {
    const cards = T.view.players[HUMAN_ID].cards;
    nodes.forEach((n, i) => paintFace(n, cards[i], 'big')); // the fronts are painted while turned away
    if (still(300, nodes[0].firstElementChild)) {
      el.hand.classList.remove('stacked');
      if (reduced()) await Promise.all(nodes.map((n) => anim(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 })));
      return;
    }
    const P = 'perspective(700px)';
    const flips = nodes.map((n) => anim(n.firstElementChild, [
      { transform: `${P} rotateY(-180deg)` },
      { transform: `${P} translateY(-6%) translateZ(70px) rotateY(-90deg)`, offset: 0.5 },
      { transform: `${P} rotateY(0deg)` },
    ], { duration: 280, easing: 'cubic-bezier(.45,.05,.35,1)' }));
    await sleep(150);
    el.hand.classList.remove('stacked'); // .card's transform transition (a spring) fans them out
    await Promise.all([...flips, sleep(340)]);
  }

  async function playAction(ev) {
    const id = ev.playerId;
    const a = ev.action;
    const v = T.view.players[id];
    v.stack = ev.stack;
    v.bet = ev.roundBet;
    v.committed += a.added;
    if (a.type === 'fold') v.folded = true;
    if (a.type === 'allin') v.allIn = true;
    const bet = a.added > 0 ? placeBet(id, v.bet, a.added, { raise: a.type === 'raise' || a.type === 'allin' }) : null;
    countTo(stackEl(id), v.stack, 500);
    if (id === HUMAN_ID) {
      if (a.type === 'fold') {
        heroCards().forEach((c) => c.classList.add('dim'));
        T.actionMode = 'wait';
      } else if (v.allIn) {
        T.actionMode = 'allin';
      }
      refreshActions();
    } else {
      showLabel(id, labelFor(a), a.type === 'allin' ? 900 : 650, a.type === 'allin');
      if (a.type === 'fold') {
        setSeatState(id);
        const minis = miniCards(id);
        minis.forEach((m) => anim(m, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 200, fill: 'forwards' }));
        setTimeout(() => minis.forEach((m) => m.remove()), dur(220));
      }
    }
    if (a.type === 'allin') {
      setSeatState(id); // the gold ring with its coral echo
      shake(el.table, 2.5, 250);
      if (id === HUMAN_ID) haptic('allin');
    }
    if (a.type === 'fold') updateEquity();
    await Promise.all([bet, sleep(id === HUMAN_ID ? 260 : 380)]);
  }

  /** The pot bumps and glows as chips arrive. */
  function potBump() {
    anim(el.potAmount, [
      { transform: 'none' }, { transform: 'scale(1.12)', offset: 0.25 }, { transform: 'scale(.98)', offset: 0.6 }, { transform: 'none' },
    ], { duration: 520, easing: 'ease-out' });
    anim(el.potGlow, [
      { opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'none', offset: 0.3 }, { opacity: 0, transform: 'scale(1.1)' },
    ], { duration: 800, easing: 'ease-out' });
  }

  /** Round end: the bubbles arc into the pot one after another, and the pot bumps and counts up. */
  async function sweepBets(newPot, token, hold = 300) {
    const to = potRect();
    const bubbles = [];
    for (const [id, v] of Object.entries(T.view.players)) {
      const b = bubbleEl(id);
      if (b && !b.hidden) bubbles.push(b);
      v.bet = 0;
    }
    const rects = bubbles.map(rectOf);
    const order = bubbles.map((b, i) => i).sort((i, j) => (rects[i] ? rects[i].left : 0) - (rects[j] ? rects[j].left : 0));
    const flights = order.map((i, k) => flyBubble(bubbles[i], rects[i], to, 32 * k));
    for (const id of Object.keys(T.view.players)) hideBubble(id);
    T.view.pot = newPot;
    if (!bubbles.length) {
      countTo(el.potAmount, newPot, 600);
      return;
    }
    await sleep(still(300) ? 0 : 250); // the first bubble reaches the pot
    if (!alive(token)) return;
    potBump();
    countTo(el.potAmount, newPot, 600);
    await Promise.all(flights);
    await sleep(hold);
  }

  /** A win is a "real" win unless it only returns a player's own uncalled chips. */
  function isRealWin(w, scores, best) {
    const v = T.view.players[w.playerId];
    return (scores[w.playerId] && scores[w.playerId].points === best) || w.amount > v.committed;
  }

  /** FLIP: make a layout change, then let `nodes` glide from where they were to where they are. */
  function glide(nodes, change, ms = 380) {
    const before = nodes.map(rectOf);
    change();
    if (still(ms)) return;
    nodes.forEach((n, i) => {
      const a = before[i];
      const b = rectOf(n);
      if (!a || !b) return;
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      anim(n, springFrames((v) => ({ transform: `translate(${(dx * (1 - v)).toFixed(1)}px, ${(dy * (1 - v)).toFixed(1)}px)` }), 0.7),
        { duration: ms, easing: 'linear' });
    });
  }

  async function playShowdown(sd, wins, sv, token) {
    T.hand.result = sv ? 'svara' : 'showdown';
    // No more decisions in this deal. If a svara you play in follows, the hand isn't over for
    // you: keep the idle bet row instead of announcing the next hand.
    const mySvara = !!sv && sv.participants.includes(HUMAN_ID);
    T.actionMode = !mySvara ? 'wait' : T.view.players[HUMAN_ID].stack > 0 ? 'bet' : 'allin';
    refreshActions();
    const ids = Object.keys(sd.cards);
    for (const id of ids) T.view.players[id].cards = sd.cards[id].map((c) => E.parseCard(c.id));
    // the opponents turn their cards over seat by seat, left to right
    const flips = [];
    ids.filter((id) => id !== HUMAN_ID).sort((a, b) => T.seatOf[a] - T.seatOf[b]).forEach((id, k) => {
      const v = T.view.players[id];
      let minis = miniCards(id);
      if (minis.length !== 3) minis = makeSlots(id).map((m) => { m.style.opacity = ''; return m; });
      minis.forEach((m, i) => flips.push(flipMini(m, () => paintFace(m, v.cards[i], 'mini'), 75 * k + 30 * i)));
    });
    await Promise.all(flips);
    if (!alive(token)) return;
    await sleep(200);
    if (!alive(token)) return;

    const best = Math.max(...ids.map((id) => sd.scores[id].points));
    const winners = new Set(wins.filter((w) => isRealWin(w, sd.scores, best)).map((w) => w.playerId));
    const tied = new Set(sv ? sv.participants : []);
    const bright = new Set([...winners, ...tied]);
    // the cards that count lift and glow; everything else greys out
    for (const id of ids) {
      const used = new Set(sd.scores[id].usedCardIds);
      const nodes = id === HUMAN_ID ? heroCards() : miniCards(id);
      nodes.forEach((n) => {
        const counts = bright.has(id) && used.has(n.dataset.card);
        n.classList.toggle('dim', !counts);
        n.classList.toggle('hot', counts);
      });
      const se = seatEl(id);
      if (se) {
        se.root.classList.toggle('won', winners.has(id));
        se.root.classList.toggle('lost', !bright.has(id));
      }
      if (isMonster(sd.scores[id])) monsterFx(nodes, id === HUMAN_ID);
    }
    const top = [...bright].map((id) => sd.scores[id]).sort((a, b) => b.points - a.points)[0];
    if (top) {
      el.pill.textContent = top.label;
      glide([el.deck, el.pot], () => { el.pill.hidden = false; }); // the pill makes room for itself
      anim(el.pill, springFrames((v) => ({
        transform: `translateY(${(-16 * (1 - v)).toFixed(1)}px) scale(${mix(0.85, 1, v).toFixed(3)})`,
        opacity: clamp(v * 2.5, 0, 1),
      }), 0.5), { duration: 520, easing: 'linear' });
    }
    el.table.dataset.result = T.hand.result;
    await sleep(400);
    if (!alive(token)) return;
    if (wins.length) await playWins(wins, winners);
  }

  /** Pay pots: the pot streams to each winner as chips; the winners celebrate as they land. */
  async function playWins(wins, real) {
    const from = potRect();
    const jobs = [];
    let pot = T.view.pot;
    let mine = 0;
    let mineLands = 0;
    wins.forEach((w, n) => {
      const v = T.view.players[w.playerId];
      v.stack += w.amount;
      pot -= w.amount;
      const counts = real ? real.has(w.playerId) : true;
      if (w.uncontested) T.hand.result = 'uncontested';
      const chips = clamp(Math.round(5 + Math.log2(1 + w.amount / T.stake.bb)), 6, 12);
      const lands = chipStream(from, avatarRect(w.playerId), chips, 140 * n);
      if (w.playerId === HUMAN_ID && counts) {
        T.hand.humanPots += 1;
        T.hand.humanWon += w.amount;
        mine += w.amount;
        mineLands = lands;
      }
      jobs.push(payout(w, v.stack, lands, counts));
    });
    T.view.pot = pot;
    jobs.push(countTo(el.potAmount, pot, 900));
    if (T.hand.result) el.table.dataset.result = T.hand.result;
    if (mine) {
      el.pot.classList.add('celebrate'); // the pot fades as it empties, making room for "Печелиш +N"
      sleep(mineLands).then(() => { if (T.game) celebrate(mine); });
    }
    await Promise.all(jobs);
  }

  /** One winner: as the chips land the avatar bounces in a gold ring and the stack counts up in green. */
  async function payout(w, stack, lands, counts) {
    await sleep(lands);
    const id = w.playerId;
    const odds = id === HUMAN_ID && el.infoBox.classList.contains('page-b'); // your avatar is not showing
    if (counts) {
      const se = seatEl(id);
      if (se) se.root.classList.add('won');
      if (!odds) bounce(avatarNode(id));
      const r = avatarRect(id);
      ringBurst(r, { from: 0.7, to: odds ? 1.15 : 2.1, duration: 650 });
      ringBurst(r, { from: 0.7, to: odds ? 1.08 : 1.6, duration: 650, delay: 90 });
    }
    // "+N" rises out of the bet spot, which is free by now
    const spot = betSpot(id);
    if (spot) floatText(`+${fmtAmt(w.amount)}`, { x: spot.x, y: spot.y + 8 }, { rise: 16, duration: 950 });
    await countTo(stackEl(id), stack, 600, { tone: true });
  }

  /** You won: light gold confetti from the pot, and "Печелиш +N" in its place. */
  function celebrate(amount) {
    haptic('win');
    const r = rectOf(el.potAmount) || potRect();
    if (!r) return;
    const c = center(r);
    confetti(c);
    floatText(`Печелиш +${fmt(amount)}`, c, { cls: 'big', rise: 16, duration: 1500 })
      .then(() => el.pot.classList.remove('celebrate'));
  }

  /** A quick soft flash over the table (none with reduced motion). */
  function flash() {
    if (reduced()) return;
    anim(el.flash, [{ opacity: 0 }, { opacity: 0.55, offset: 0.2 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' });
  }

  /**
   * Svara: the table dims around the middle, the tied players glow gold, and СВАРА! slams down
   * from a big scale; at the impact a soft flash, a shockwave ring and a small shake.
   */
  async function playSvara(ev) {
    T.svaras += 1;
    el.table.dataset.svaras = String(T.svaras);
    T.view.svara = { pot: ev.svaraPot, cost: ev.joinCost, participants: ev.participants.slice() };
    el.svaraSub.textContent = `Банка ${fmt(ev.svaraPot)} · Влизане ${fmt(ev.joinCost)}`;
    el.pill.hidden = true;
    el.middle.classList.add('svara');
    el.banner.hidden = false;
    el.table.dataset.result = 'svara';
    el.table.classList.add('svara-dim');
    ev.participants.forEach((id) => markTied(id, true));
    haptic('svara');
    if (still(340, el.banner)) {
      await anim(el.banner, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    } else {
      const slam = anim(el.banner, [
        { transform: 'scale(2.6)', opacity: 0, easing: 'cubic-bezier(.55,0,.85,.4)' },
        { transform: 'scale(.93)', opacity: 1, offset: 0.62, easing: 'cubic-bezier(.2,.7,.3,1)' },
        { transform: 'scale(1.03)', opacity: 1, offset: 0.82 },
        { transform: 'none', opacity: 1 },
      ], { duration: 340, easing: 'linear' });
      await sleep(210); // the impact
      flash();
      const word = rectOf(el.banner.firstElementChild);
      if (word) {
        const c = center(word);
        const s = word.height * 1.6;
        const box = { left: c.x - s / 2, top: c.y - s / 2, width: s, height: s };
        ringBurst(box, { cls: 'shock', from: 0.3, to: 3.6, duration: 620 });
        ringBurst(box, { cls: 'shock', from: 0.3, to: 2.4, duration: 560, delay: 90 });
      }
      shake(el.table, 3, 260);
      await slam;
    }
    await sleep(ev.pending && ev.pending.length ? 600 : 650);
  }

  async function playSvaraDecision(ev) {
    const id = ev.playerId;
    const v = T.view.players[id];
    if (ev.type === 'svara-join') {
      v.stack -= ev.paid;
      T.view.pot += ev.paid;
      if (T.view.svara) {
        T.view.svara.pot += ev.paid;
        T.view.svara.participants.push(id);
        el.svaraSub.textContent = `Банка ${fmt(T.view.svara.pot)} · Влизане ${fmt(T.view.svara.cost)}`;
      }
      setNum(el.potAmount, T.view.pot);
      countTo(stackEl(id), v.stack, 450);
      markTied(id, true); // a joiner steps into the light with the others
      if (id !== HUMAN_ID) showLabel(id, 'Влиза');
    } else if (id !== HUMAN_ID) {
      showLabel(id, 'Отказва');
    }
    await sleep(id === HUMAN_ID ? 200 : 420);
  }

  /** The svara deal: every card flies back into the deck, the deck reshuffles, then the new deal. */
  async function playSvaraStart(ev, token) {
    const parts = new Set(ev.participants);
    for (const id of Object.keys(T.view.players)) markTied(id, false);
    const old = heroCards();
    for (let s = 1; s < SEATS; s++) if (T.seatEls[s]) old.push(...T.seatEls[s].cards.children);
    // The banner fades but keeps its place, so the deck stays put for the cards and the shuffle.
    const fade = anim(el.banner, [{ opacity: 1 }, { opacity: 0 }], { duration: 180 }).then(() => { el.banner.style.opacity = '0'; });
    await Promise.all([fade, returnCards(old)]);
    if (!alive(token)) return;
    await riffle();
    if (!alive(token)) return;
    el.banner.hidden = true;
    el.banner.style.opacity = '';
    el.middle.classList.remove('svara');
    el.table.classList.remove('svara-dim');
    el.pill.hidden = true;
    el.pot.classList.remove('celebrate');
    el.table.dataset.result = '';
    for (const [id, v] of Object.entries(T.view.players)) {
      v.inHand = parts.has(id);
      v.folded = false;
      v.bet = 0;
      v.committed = 0;
      v.cards = null;
      v.allIn = v.inHand && v.stack === 0;
      hideBubble(id);
      const se = seatEl(id);
      if (se) se.root.classList.remove('won', 'lost', 'labeled');
      setSeatState(id);
    }
    T.view.pot = ev.pot;
    T.view.svara = null;
    el.potLabel.textContent = 'Свара';
    stopCount(el.potAmount);
    setNum(el.potAmount, ev.pot);
    updateInfoBox();
    const me = T.view.players[HUMAN_ID];
    T.actionMode = !me || !me.inHand ? 'wait' : me.allIn ? 'allin' : 'bet';
    refreshActions();
  }

  function playHandOver() {
    const h = T.hand;
    let gained = 0;
    if (h.humanDealt) {
      P.handsPlayed += 1;
      gained += 1; // +1 XP per hand played
    }
    if (h.humanPots > 0) {
      P.handsWon += 1;
      gained += 5 * h.humanPots; // +5 XP per pot won
      P.biggestPot = Math.max(P.biggestPot, h.humanWon);
    }
    P.xp += gained;
    T.sessionXp += gained;
    if (gained) showSessionXp();
    el.table.dataset.result = h.result || 'uncontested';
    const me = T.view.players[HUMAN_ID];
    if (me && !me.folded && me.inHand && !h.humanPots) heroCards().forEach((c) => c.classList.add('dim'));
    T.actionMode = 'wait';
    refreshActions();
  }

  // ---------------------------------------------------------------------------------------------
  // View ↔ engine consistency
  // ---------------------------------------------------------------------------------------------

  /** Rebuild the numbers on screen from the engine state (after an error or a drift). */
  function resyncView(s) {
    if (!T.game) return;
    const st = s || T.game.getState();
    if (!T.view) T.view = freshView(st);
    let bets = 0;
    for (const p of st.players) {
      const v = T.view.players[p.id] || (T.view.players[p.id] = { committed: 0, cards: null });
      Object.assign(v, { stack: p.stack, bet: p.roundBet, folded: p.folded, allIn: p.allIn, inHand: p.inHand });
      bets += p.roundBet;
      T.seatOf[p.id] = p.seat;
      stopCount(stackEl(p.id));
      setNum(stackEl(p.id), p.stack);
      if (p.roundBet > 0) showBubble(p.id, p.roundBet);
      else hideBubble(p.id);
      if (p.id !== HUMAN_ID) setSeatState(p.id);
    }
    T.view.pot = st.pot - bets;
    stopCount(el.potAmount);
    setNum(el.potAmount, T.view.pot);
    const me = st.players.find((p) => p.id === HUMAN_ID);
    if (st.phase === 'betting' && me) T.actionMode = !me.inHand || me.folded ? 'wait' : me.allIn ? 'allin' : 'bet';
    else if (st.phase !== 'betting') T.actionMode = 'wait';
    refreshActions();
  }

  function checkSync() {
    const s = T.game.getState();
    el.table.dataset.phase = s.phase;
    let bets = 0;
    const drift = [];
    for (const p of s.players) {
      const v = T.view.players[p.id];
      bets += p.roundBet;
      if (!v || v.stack !== p.stack || v.bet !== p.roundBet) drift.push(p.id);
    }
    if (T.view.pot !== s.pot - bets) drift.push('pot');
    if (drift.length) {
      console.warn('[svara] view drift, resyncing:', drift.join(', '));
      resyncView(s);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Action row
  // ---------------------------------------------------------------------------------------------

  function legal() {
    if (!T.game) return null;
    try {
      return T.game.legalActions(HUMAN_ID);
    } catch (e) {
      return null;
    }
  }

  function setBtn(btn, { show = true, label, amount = '', enabled = false, illegal = false }) {
    btn.hidden = !show;
    if (!show) return;
    if (label != null) btn.querySelector('.lbl').textContent = label;
    const amt = btn.querySelector('.amt');
    if (amt) amt.textContent = amount;
    btn.disabled = !enabled;
    btn.classList.toggle('illegal', illegal);
  }

  /** The bottom row: [Пас] [Чек|Плащам] [Залагам|Вдигам] [↑], [Пас] [Ва банк], or one wide button. */
  function refreshActions() {
    const w = T.waiting;
    const myTurn = !!(w && w.kind === 'act');
    el.table.classList.toggle('turn', myTurn);
    el.table.dataset.turn = myTurn ? '1' : '0';
    const b = el.btns;
    const hideAll = () => Object.values(b).forEach((x) => { x.hidden = true; });
    hideAll();
    let layout = 'single';
    const mode = T.actionMode;
    if (mode === 'bet') {
      const L = T.game && T.game.getState().phase === 'svara-offer' ? null : legal(); // no stale amounts
      if (L && L.callIsAllIn) {
        layout = 'allin-only';
        setBtn(b.fold, { enabled: myTurn && L.canFold });
        setBtn(b.allin, { label: 'Ва банк', amount: fmtAmt(L.allInAmount), enabled: myTurn && (L.canAllIn || L.canCall) });
      } else {
        layout = 'bet';
        const toCall = L ? L.toCall : 0;
        setBtn(b.fold, { enabled: myTurn && !!L && L.canFold });
        setBtn(b.call, {
          label: toCall > 0 ? 'Плащам' : 'Чек',
          amount: toCall > 0 ? fmtAmt(L.callAmount) : '',
          enabled: myTurn && !!L && (L.canCheck || L.canCall),
        });
        const short = !!L && L.maxRaiseTo < L.minRaiseTo && L.allInAmount > L.callAmount;
        if (short) {
          setBtn(b.raise, { label: 'Ва банк', amount: fmtAmt(L.allInAmount), enabled: myTurn && L.canAllIn, illegal: myTurn && !L.canAllIn });
        } else {
          setBtn(b.raise, {
            label: !L || L.isBet ? 'Залагам' : 'Вдигам',
            amount: L ? fmtAmt(L.minRaiseTo) : '',
            enabled: myTurn && !!L && L.canRaise,
            illegal: myTurn && !!L && !L.canRaise,
          });
        }
        b.more.hidden = false;
        b.more.disabled = !(myTurn && L && L.canRaise);
        b.more.classList.toggle('illegal', myTurn && !!L && !L.canRaise);
      }
    } else if (mode === 'allin') {
      setBtn(b.allin, { label: 'Ва банк', amount: '', enabled: false });
    } else {
      setBtn(b.next, { label: 'Следваща ръка', enabled: mode === 'next' && !!(w && w.kind === 'next') });
    }
    el.actions.dataset.mode = layout;
    el.actions.dataset.state = mode;
    el.actions.classList.toggle('ready', !!(w && w.kind === 'next'));
    scheduleFit();
  }

  /** Fit the labels once, in the next frame: several refreshes in a row share one measurement. */
  let fitRaf = 0;
  function scheduleFit() {
    if (!fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; fitLabels(); });
  }

  /** "Плащам 1 000" stays on one line when it fits; otherwise the amount drops below. */
  let fitKey = '';
  function fitLabels() {
    const btns = [el.btns.call, el.btns.raise, el.btns.allin].filter((b) => !b.hidden);
    // measuring forces a layout: only do it when the labels, the layout or the width changed
    const key = `${el.actions.dataset.mode}|${window.innerWidth}|${screens.table.hidden}|${btns.map((b) => `${b.id}:${b.textContent}`).join('|')}`;
    if (key === fitKey) return;
    fitKey = key;
    btns.forEach((b) => b.classList.remove('stack'));
    const overflow = btns.some((b) => b.firstElementChild.scrollWidth > b.firstElementChild.clientWidth + 0.5);
    // side by side buttons stack together, so the row reads evenly
    if (overflow) btns.forEach((b) => b.classList.add('stack'));
  }

  // ---------------------------------------------------------------------------------------------
  // Waiting for you
  // ---------------------------------------------------------------------------------------------

  function waitHuman(kind) {
    return new Promise((resolve) => {
      T.waiting = { kind, resolve };
      refreshActions();
      if (kind === 'act') {
        haptic('turn');
        shineActions();
      }
    });
  }

  /** Your turn: a light band sweeps once across each enabled button, left to right. */
  function shineActions() {
    if (still(560)) return;
    const bands = Array.from(el.actions.querySelectorAll('.act:not([hidden]):not(:disabled) .act-shine'));
    bands.forEach((band, i) => anim(band, [
      { transform: 'translateX(-120%) skewX(-20deg)', opacity: 1 },
      { transform: 'translateX(330%) skewX(-20deg)', opacity: 1 },
    ], { duration: 560, delay: 60 * i, easing: 'cubic-bezier(.4,0,.2,1)' }));
  }

  /** The info box flips over to its other page (stack ↔ odds); the page swaps while it is edge-on. */
  function toggleInfo() {
    const box = el.infoBox;
    if (still(300, box)) {
      box.classList.toggle('page-b');
      return;
    }
    box.classList.add('flipping');
    box.classList.toggle('page-b');
    const P = 'perspective(600px)';
    anim(box, [
      { transform: `${P} rotateX(0deg)`, easing: 'ease-in' },
      { transform: `${P} rotateX(90deg)`, offset: 0.5 },
      { transform: `${P} rotateX(-90deg)`, offset: 0.5, easing: 'ease-out' },
      { transform: `${P} rotateX(0deg)` },
    ], { duration: 300, easing: 'linear' }).then(() => box.classList.remove('flipping'));
  }

  function resolveHuman(kind, value) {
    const w = T.waiting;
    if (!w || w.kind !== kind) return false;
    T.waiting = null;
    refreshActions();
    w.resolve(value);
    return true;
  }

  function isLegal(a, L) {
    if (!a || !L || !L.isTurn) return false;
    switch (a.type) {
      case 'fold': return L.canFold;
      case 'check': return L.canCheck;
      case 'call': return L.canCall;
      case 'allin': return L.canAllIn;
      case 'raise':
        return Number.isInteger(a.amount) &&
          ((L.canRaise && a.amount >= L.minRaiseTo && a.amount <= L.maxRaiseTo) || (a.amount === L.maxRaiseTo && L.canAllIn));
      default: return false;
    }
  }

  function humanAct(action) {
    if (!T.waiting || T.waiting.kind !== 'act') return;
    const L = legal();
    if (!isLegal(action, L)) return;
    resolveHuman('act', action);
  }

  function bindTable() {
    const b = el.btns;
    b.fold.addEventListener('click', () => humanAct({ type: 'fold' }));
    b.call.addEventListener('click', () => {
      const L = legal();
      if (L) humanAct(L.toCall > 0 ? { type: 'call' } : { type: 'check' });
    });
    b.raise.addEventListener('click', () => {
      const L = legal();
      if (!L) return;
      if (L.maxRaiseTo < L.minRaiseTo) humanAct({ type: 'allin' });
      else humanAct({ type: 'raise', amount: L.minRaiseTo });
    });
    b.more.addEventListener('click', openRaiseSheet);
    b.allin.addEventListener('click', () => {
      const L = legal();
      if (L) humanAct(L.canAllIn ? { type: 'allin' } : { type: 'call' });
    });
    b.next.addEventListener('click', () => resolveHuman('next', true));
    el.infoBox.addEventListener('click', toggleInfo);
    el.btnLeave.addEventListener('click', () => openSheet('leave'));
    $('btn-leave-stay').addEventListener('click', () => closeSheet('leave'));
    $('btn-leave-confirm').addEventListener('click', leaveTable);
    $('btn-svara-join').addEventListener('click', () => { if (resolveHuman('svara', true)) closeSheet('svara'); });
    $('btn-svara-decline').addEventListener('click', () => { if (resolveHuman('svara', false)) closeSheet('svara'); });
    $('btn-rebuy').addEventListener('click', () => { if (resolveHuman('busted', 'rebuy')) closeSheet('busted'); });
    $('btn-busted-home').addEventListener('click', () => { if (resolveHuman('busted', 'home')) closeSheet('busted'); });
    bindRaiseSheet();
    el.backdrop.addEventListener('click', dismissSheet);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') dismissSheet();
      if (e.key === 'Tab' && openName) trapFocus(e, sheets[openName]);
    });
  }

  /** Keep Tab inside the open sheet. */
  function trapFocus(e, sheet) {
    const items = Array.from(sheet.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /** Backdrop tap / Escape: only the leave and raise sheets can be dismissed. */
  function dismissSheet() {
    if (openName === 'leave' || openName === 'raise') closeSheet(openName);
  }

  // --- raise sheet -----------------------------------------------------------------------------

  let raiseCtx = null;

  function openRaiseSheet() {
    if (!T.waiting || T.waiting.kind !== 'act') return;
    const L = legal();
    if (!L || !L.canRaise) return;
    const s = T.game.getState();
    const bb = s.bb;
    const amounts = [L.minRaiseTo];
    for (let a = (Math.floor(L.minRaiseTo / bb) + 1) * bb; a < L.maxRaiseTo; a += bb) amounts.push(a);
    if (amounts[amounts.length - 1] !== L.maxRaiseTo) amounts.push(L.maxRaiseTo);
    const nearest = (target) => {
      const t = Math.round(target / bb) * bb;
      let best = 0;
      for (let i = 0; i < amounts.length; i++) if (Math.abs(amounts[i] - t) < Math.abs(amounts[best] - t)) best = i;
      return best;
    };
    const potAfterCall = s.pot + L.toCall;
    const presets = {
      min: 0,
      half: nearest(L.isBet ? s.pot / 2 : s.currentBet + potAfterCall / 2),
      pot: nearest(L.isBet ? s.pot : s.currentBet + potAfterCall),
      allin: amounts.length - 1,
    };
    raiseCtx = { L, amounts, presets, idx: 0 };
    openSheet('raise', () => {
      el.raiseSlider.max = String(amounts.length - 1);
      el.raiseSlider.value = '0';
      el.raiseSlider.disabled = amounts.length < 2;
      el.raiseMin.textContent = fmtAmt(amounts[0]);
      el.raiseMax.textContent = fmtAmt(amounts[amounts.length - 1]);
      renderRaise();
    });
  }

  function renderRaise() {
    if (!raiseCtx) return;
    const { L, amounts, presets, idx } = raiseCtx;
    const amount = amounts[idx];
    const allIn = amount === L.maxRaiseTo;
    el.raiseLabel.textContent = allIn ? 'Ва банк' : L.isBet ? 'Залагам' : 'Вдигам до';
    el.raiseAmount.textContent = fmt(amount);
    el.raiseConfirm.textContent = allIn ? `Ва банк ${fmt(amount)}` : L.isBet ? `Залагам ${fmt(amount)}` : `Вдигам до ${fmt(amount)}`;
    for (const btn of el.presets) btn.classList.toggle('on', presets[btn.dataset.preset] === idx);
    el.raiseSlider.setAttribute('aria-valuetext', fmt(amount));
  }

  function bindRaiseSheet() {
    el.raiseSlider.addEventListener('input', () => {
      if (!raiseCtx) return;
      raiseCtx.idx = Number(el.raiseSlider.value) || 0;
      renderRaise();
    });
    for (const btn of el.presets) {
      btn.addEventListener('click', () => {
        if (!raiseCtx) return;
        raiseCtx.idx = raiseCtx.presets[btn.dataset.preset];
        el.raiseSlider.value = String(raiseCtx.idx);
        renderRaise();
      });
    }
    el.raiseConfirm.addEventListener('click', () => {
      if (!raiseCtx) return;
      const { L, amounts, idx } = raiseCtx;
      const amount = amounts[idx];
      raiseCtx = null;
      closeSheet('raise');
      humanAct(amount === L.maxRaiseTo && L.canAllIn ? { type: 'allin' } : { type: 'raise', amount });
    });
    $('btn-raise-cancel').addEventListener('click', () => { raiseCtx = null; closeSheet('raise'); });
  }

  // ---------------------------------------------------------------------------------------------
  // The game loop (exactly one runs at a time; T.token identifies it)
  // ---------------------------------------------------------------------------------------------

  function startLoop(pause = 400) {
    const token = ++T.token;
    T.errors = 0;
    runLoop(token, pause);
  }

  async function runLoop(token, pause) {
    await sleep(pause); // let the empty table show before the first deal
    while (alive(token)) {
      try {
        if (!(await loopStep(token))) return;
        T.errors = 0;
      } catch (err) {
        console.error('[svara] game loop error:', err);
        if (!alive(token) || ++T.errors > 3) return;
        resyncView();
        await sleep(300);
      }
    }
  }

  /** One engine call (or one wait). Returns false when the loop should stop. */
  async function loopStep(token) {
    const s = T.game.getState();
    switch (s.phase) {
      case 'idle':
        await step(() => T.game.startHand(), token);
        return true;
      case 'betting':
        if (s.toAct === HUMAN_ID) {
          const action = await waitHuman('act');
          if (!alive(token) || !action) return false;
          await step(() => T.game.act(HUMAN_ID, action), token);
        } else {
          await botTurn(s.toAct, token);
        }
        return true;
      case 'svara-offer': {
        const bot = s.pendingSvaraDecisions.find((id) => id !== HUMAN_ID);
        if (bot) {
          await sleep(rand(450, 800));
          if (!alive(token)) return false;
          const join = AI.decideSvaraJoin(T.game.getState(), bot, (T.bots[bot] || {}).personality || 'tag');
          await step(() => T.game.svaraJoin(bot, join), token);
        } else if (s.pendingSvaraDecisions.includes(HUMAN_ID)) {
          const join = await humanSvaraOffer(s);
          if (!alive(token) || join == null) return false;
          await step(() => T.game.svaraJoin(HUMAN_ID, join), token);
        } else {
          throw new Error('svara-offer without pending decisions');
        }
        return true;
      }
      case 'hand-over': {
        const go = await betweenHands(token);
        if (!go || !alive(token)) return false;
        replaceBustedBots();
        await step(() => T.game.nextHand(), token);
        return true;
      }
      default:
        throw new Error(`unexpected phase '${s.phase}'`);
    }
  }

  async function step(fn, token) {
    const pre = T.game.getState();
    const events = fn();
    await playEvents(events, pre, token);
    if (!alive(token)) return;
    checkSync();
    saveProfile();
  }

  async function botTurn(id, token) {
    const se = seatEl(id);
    const me = T.view.players[HUMAN_ID];
    const humanLive = me && me.inHand && !me.folded;
    const think = rand(700, 1300) * (humanLive ? 1 : 0.6);
    if (se) {
      se.root.classList.add('thinking');
      startThinkRing(se, think);
    }
    await sleep(think);
    if (se) se.root.classList.remove('thinking');
    if (!alive(token)) return;
    const s = T.game.getState();
    if (s.phase !== 'betting' || s.toAct !== id) return;
    const action = AI.decide(s, id, (T.bots[id] || {}).personality || 'tag');
    await step(() => T.game.act(id, action), token);
  }

  function humanSvaraOffer(s) {
    const names = s.svaraParticipants.map((id) => (id === HUMAN_ID ? HUMAN_NAME : (s.players.find((p) => p.id === id) || {}).name)).join(', ');
    const p = waitHuman('svara');
    openSheet('svara', () => {
      el.svaraTitle.textContent = `Свара! Влез за ${fmt(s.svaraJoinCost)}?`;
      el.svaraBody.textContent = `Банка ${fmt(s.svaraPot)} · В сварата: ${names}`;
    });
    return p;
  }

  /** After a hand: Следваща ръка, or the busted sheet when you are out of chips. */
  async function betweenHands(token) {
    const me = T.game.getState().players.find((p) => p.id === HUMAN_ID);
    if (!me || me.stack <= 0) {
      await sleep(600);
      if (!alive(token)) return false;
      const choice = await waitBusted();
      if (!alive(token) || choice == null) return false;
      const N = Math.min(T.stake.maxBuyIn, P.bankroll);
      if (choice !== 'rebuy' || P.bankroll < T.stake.minBuyIn) {
        leaveTable();
        return false;
      }
      P.bankroll -= N;
      T.game.addChips(HUMAN_ID, N);
      T.view.players[HUMAN_ID].stack += N;
      countTo(el.infoStack, T.view.players[HUMAN_ID].stack, 500, { tone: true });
      saveProfile();
      toast(`+${fmt(N)} чипа на масата`);
      return true;
    }
    await sleep(250);
    if (!alive(token)) return false;
    T.actionMode = 'next';
    const go = await waitHuman('next');
    return !!go;
  }

  function waitBusted() {
    const p = waitHuman('busted');
    const N = Math.min(T.stake.maxBuyIn, P.bankroll);
    const can = P.bankroll >= T.stake.minBuyIn;
    openSheet('busted', () => {
      el.rebuy.disabled = !can;
      el.rebuy.textContent = can ? `Купи отново ${fmt(N)}` : 'Купи отново';
      el.bustedBody.textContent = can
        ? `В банката имаш ${fmt(P.bankroll)}. Купи отново или се върни в началото.`
        : `В банката имаш ${fmt(P.bankroll)}, а входът е поне ${fmt(T.stake.minBuyIn)}.`;
    });
    return p;
  }

  /** Busted bots leave between hands; a new bot from the pool sits down with a fresh buy-in. */
  function replaceBustedBots() {
    const s = T.game.getState();
    const seated = new Set(s.players.map((p) => T.bots[p.id] && T.bots[p.id].key).filter(Boolean));
    const names = [];
    for (const p of s.players) {
      if (p.isHuman || p.stack > 0) continue;
      const free = BOT_POOL.filter((b) => !seated.has(b.key));
      const b = (free.length ? free : BOT_POOL)[Math.floor(Math.random() * (free.length || BOT_POOL.length))];
      seated.add(b.key);
      delete T.bots[p.id];
      T.game.setPlayer(p.seat, makeBotPlayer(b));
      names.push(b.name);
    }
    if (names.length === 1) toast(`${names[0]} сяда на масата`);
    else if (names.length > 1) toast(`${names.slice(0, -1).join(', ')} и ${names[names.length - 1]} сядат на масата`);
  }

  function leaveTable() {
    if (!T.game) return;
    P.bankroll += tableStack(); // committed chips of a running hand are lost
    T.token++;
    const w = T.waiting;
    T.waiting = null;
    if (w) w.resolve(null);
    T.game = null;
    raiseCtx = null;
    for (const node of Array.from(countJobs.keys())) stopCount(node);
    closeAllSheets();
    el.fx.replaceChildren();
    FX.clear();
    el.table.classList.remove('turn');
    saveProfile();
    homeFromTable();
  }

  // ---------------------------------------------------------------------------------------------
  // Debug hook (used by tests and reviewers)
  // ---------------------------------------------------------------------------------------------

  function rig(hands) {
    if (!hands || typeof hands !== 'object') throw new Error('rig: expected { playerId: [cardId, cardId, cardId] }');
    const st = T.game ? T.game.getState() : null;
    const out = {};
    const seen = new Set();
    for (const [key, cards] of Object.entries(hands)) {
      let id = key;
      if (key === 'human') id = HUMAN_ID;
      else if (/^\d+$/.test(key) && st) {
        const p = st.players.find((q) => q.seat === Number(key));
        if (p) id = p.id;
      }
      if (!Array.isArray(cards) || cards.length !== 3) throw new Error(`rig: ${key} needs exactly 3 cards`);
      out[id] = cards.map((c) => {
        const card = E.parseCard(typeof c === 'string' ? c : c && c.id);
        if (seen.has(card.id)) throw new Error(`rig: card ${card.id} is used twice`);
        seen.add(card.id);
        return card.id;
      });
    }
    T.rig = out;
    return true;
  }

  function setSpeed(f) {
    const v = Number(f);
    SPEED = Number.isFinite(v) && v >= 0 ? Math.min(v, 10) : 1;
    document.documentElement.style.setProperty('--speed', String(SPEED));
    return SPEED;
  }

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------

  function grab() {
    screens.home = $('screen-home');
    screens.stakes = $('screen-stakes');
    screens.table = $('screen-table');
    for (const name of ['leave', 'raise', 'svara', 'busted']) sheets[name] = $(`sheet-${name}`);
    Object.assign(el, {
      table: screens.table,
      homeScroll: $('home-scroll'),
      homeBankroll: $('home-bankroll'),
      homeXp: $('home-xp-value'),
      levelValue: $('home-level-value'),
      levelArc: $('level-arc'),
      freeChips: $('btn-free-chips'),
      modes: $('modes'),
      modeAi: $('mode-ai'),
      leaderboard: $('leaderboard'),
      stakesBankroll: $('stakes-bankroll'),
      stakesValue: $('stakes-value'),
      buyinValue: $('buyin-value'),
      stakesNote: $('stakes-note'),
      stakesPanel: screens.stakes.querySelector('.stakes-panel'),
      stakesSlider: $('stakes-slider'),
      stakesSeat: $('stakes-seat'),
      btnStart: $('btn-start'),
      btnStakesBack: $('btn-stakes-back'),
      btnLeave: $('btn-leave'),
      tableXp: $('table-xp'),
      tableStakes: $('table-stakes'),
      tableXpValue: $('table-xp-value'),
      opps: $('opps'),
      middle: $('middle'),
      deck: $('deck'),
      deckTop: $('deck-top'),
      pill: $('hand-pill'),
      pot: $('pot'),
      potGlow: $('pot-glow'),
      potLabel: $('pot-label'),
      potAmount: $('pot-amount'),
      banner: $('svara-banner'),
      svaraSub: $('svara-sub'),
      heroBubble: $('hero-bubble'),
      actions: $('actions'),
      handRow: $('hand-row'),
      hand: $('hand'),
      infoBox: $('info-box'),
      infoHand: $('info-hand'),
      infoAvatar: $('info-avatar'),
      infoStack: $('info-stack'),
      heroDealer: $('hero-dealer'),
      eqWin: $('eq-win'),
      eqTie: $('eq-tie'),
      sheetLayer: $('sheet-layer'),
      backdrop: $('backdrop'),
      raiseLabel: $('raise-label'),
      raiseAmount: $('raise-amount'),
      raiseSlider: $('raise-slider'),
      raiseMin: $('raise-min'),
      raiseMax: $('raise-max'),
      raiseConfirm: $('btn-raise-confirm'),
      presets: Array.from(document.querySelectorAll('.preset')),
      svaraTitle: $('svara-title'),
      svaraBody: $('svara-body'),
      rebuy: $('btn-rebuy'),
      bustedBody: $('busted-body'),
      flash: $('flash'),
      fx: $('fx'),
      toast: $('toast'),
    });
    FX.init($('fx-canvas'));
    el.homeBankroll._fmt = fmtWide;
    el.infoStack._fmt = fmtWide;
    el.btns = {
      fold: $('btn-fold'), call: $('btn-call'), raise: $('btn-raise'), more: $('btn-raise-more'),
      allin: $('btn-allin'), next: $('btn-next'),
    };
  }

  function bindHome() {
    $('mode-ai').addEventListener('click', goStakes);
    $('mode-online').addEventListener('click', () => toast('Скоро'));
    $('nav-shop').addEventListener('click', () => toast('Скоро'));
    $('nav-profile').addEventListener('click', () => toast('Скоро'));
    $('nav-home').addEventListener('click', () => el.homeScroll.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }));
    $('btn-lb-help').addEventListener('click', () => toast('+1 XP за всяка ръка · +5 XP за спечелена банка'));
    el.freeChips.addEventListener('click', () => {
      P.bankroll += FREE_CHIPS;
      saveProfile();
      el.freeChips.hidden = true;
      countTo(el.homeBankroll, P.bankroll, 900, { tone: true, ease: easeExpo });
    });
    el.modes.addEventListener('scroll', onModesScroll, { passive: true });
    window.addEventListener('resize', () => {
      if (!modeRaf) modeRaf = requestAnimationFrame(updateModeScale);
      if (screenName === 'table') fitLabels();
      FX.resize();
    });
  }

  let started = false;
  function start(data) {
    if (started) return;
    started = true;
    const fromHot = data && typeof data === 'object' && typeof data.bankroll === 'number' ? sanitizeProfile(data) : null;
    Object.assign(P, fromHot || loadStored() || {});
    grab();
    buildTicks();
    bindHome();
    bindStakes();
    bindTable();
    showOnly('home');
    screenName = 'home';
    renderHome(true);
    requestAnimationFrame(updateModeScale);
    window.addEventListener('pagehide', saveProfile);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveProfile(); });
    if (window.claude && window.claude.hot && typeof window.claude.hot.snapshot === 'function') {
      window.claude.hot.snapshot(() => profileSnapshot());
    }
    window.__svaraDebug = {
      getState: () => (T.game ? T.game.getState() : null),
      setSpeed,
      rig,
      get game() { return T.game; },
      screen: () => screenName,
      profile: () => ({ ...P }),
    };
  }

  window.claude?.hot?.ready ? window.claude.hot.ready(start) : start(window.claude?.hot?.data ?? {});
})();
