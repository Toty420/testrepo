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

  /** Card flip: squeeze to the edge (darkening a little), repaint, open up again. */
  async function flip(node, paint, delay = 0) {
    if (reduced() || dur(250) < 2 || typeof node.animate !== 'function') {
      paint();
      if (!reduced()) return;
      await anim(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      return;
    }
    const a1 = node.animate(
      [{ transform: 'scaleX(1)', filter: 'brightness(1)' }, { transform: 'scaleX(0)', filter: 'brightness(.75)' }],
      { duration: dur(115), delay: dur(delay), easing: 'ease-in', fill: 'forwards' });
    await settle(a1, dur(115 + delay));
    paint();
    const a2 = node.animate(
      [{ transform: 'scaleX(0)', filter: 'brightness(.75)' }, { transform: 'scaleX(1)', filter: 'brightness(1)' }],
      { duration: dur(135), easing: 'ease-out' });
    a1.cancel();
    await settle(a2, dur(135));
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

  /** Mode carousel: the centered card is full size, its neighbours shrink to 0.9. */
  let modeRaf = 0;
  function updateModeScale() {
    modeRaf = 0;
    const box = el.modes.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    for (const card of el.modes.children) {
      const r = card.getBoundingClientRect();
      const w = card.offsetWidth || 1;
      const t = Math.min(1, Math.max(0, (Math.abs(r.left + r.width / 2 - cx) - 20) / w));
      card.style.setProperty('--mode-scale', (1 - 0.1 * t).toFixed(3));
    }
  }

  function showOnly(name) {
    for (const [n, s] of Object.entries(screens)) s.hidden = n !== name;
  }

  async function goStakes() {
    if (screenName !== 'home') return;
    screenName = 'stakes';
    hideToast();
    stakeIdx = defaultStake();
    renderStakes();
    setNum(el.stakesBankroll, P.bankroll);
    screens.stakes.hidden = false;
    const frames = reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: 'translateY(100%)' }, { transform: 'none' }];
    await anim(screens.stakes, frames, { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    if (screenName === 'stakes') {
      screens.home.hidden = true;
      el.stakesSlider.focus({ preventScroll: true });
    }
  }

  async function backHome() {
    if (screenName !== 'stakes') return;
    screenName = 'home';
    hideToast();
    screens.home.hidden = false;
    renderHome(true);
    const frames = reduced() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'none' }, { transform: 'translateY(100%)' }];
    await anim(screens.stakes, frames, { duration: 200, easing: 'ease-in' });
    if (screenName === 'home') screens.stakes.hidden = true;
  }

  async function homeFromTable() {
    screenName = 'home';
    hideToast();
    screens.home.hidden = false;
    screens.stakes.hidden = true;
    renderHome(false); // keep the old number: it counts to the new bankroll below
    el.homeScroll.scrollTop = 0;
    await anim(screens.table, [{ opacity: 1 }, { opacity: 0 }], { duration: 260 });
    if (screenName !== 'home') return;
    screens.table.hidden = true;
    requestAnimationFrame(updateModeScale);
    await sleep(500);
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
    await anim(screens.table, [{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    if (screenName !== 'table') return;
    screens.stakes.hidden = true;
    screens.home.hidden = true;
    startLoop();
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
        '<div class="seat-body"><div class="seat-avatar"><span class="emoji"></span><span class="dealer" hidden>D</span></div>' +
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
      se.root.classList.remove('folded', 'out', 'won', 'lost', 'labeled', 'thinking');
      se.cards.replaceChildren();
      se.bubble.hidden = true;
    }
    el.hand.replaceChildren();
    el.heroBubble.hidden = true;
    el.pill.hidden = true;
    el.banner.hidden = true;
    el.middle.classList.remove('svara');
    el.potLabel.textContent = 'Банка';
    stopCount(el.potAmount);
    setNum(el.potAmount, 0);
    el.table.dataset.result = '';
    el.infoHand.textContent = '';
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

  function showBubble(id, amount) {
    const b = bubbleEl(id);
    if (!b) return;
    const wasHidden = b.hidden;
    b.textContent = fmtAmt(amount);
    b.hidden = false;
    if (wasHidden) anim(b, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 140 });
  }

  function hideBubble(id) {
    const b = bubbleEl(id);
    if (b) b.hidden = true;
  }

  function showLabel(id, text, ms = 650) {
    const se = seatEl(id);
    if (!se) return;
    se.label.textContent = text;
    se.root.classList.add('labeled');
    clearTimeout(se.labelTimer);
    se.labelTimer = setTimeout(() => se.root.classList.remove('labeled'), dur(ms));
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

  /** Paint a card face. kind: 'big' (your hand) or 'mini' (under an opponent). */
  function paintFace(node, card, kind) {
    const c = typeof card === 'string' ? E.parseCard(card) : card;
    node.classList.remove('back');
    node.classList.toggle('red', !!RED[c.suit]);
    node.dataset.card = c.id;
    node.setAttribute('aria-label', c.id);
    const r = document.createElement('span');
    r.className = 'r' + (c.rank === '10' ? ' ten' : '');
    r.textContent = c.rank;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = SUIT[c.suit];
    node.replaceChildren(r, s);
    if (kind === 'big' && E.isJoker(c, true)) {
      const j = document.createElement('span');
      j.className = 'jk';
      j.title = 'Шпока';
      j.textContent = '★';
      node.appendChild(j);
    }
  }

  function makeSlots(id) {
    const nodes = [0, 1, 2].map((i) => {
      const n = div(id === HUMAN_ID ? 'card back' : 'mini back');
      if (id === HUMAN_ID) n.style.setProperty('--i', String(i));
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
    const se = seatEl(id);
    const v = T.view.players[id];
    if (!se || !v) return;
    se.root.classList.toggle('out', !v.inHand);
    se.root.classList.toggle('folded', v.inHand && v.folded);
  }

  /** "21 точки" + win/svara odds against the opponents still in. */
  function updateInfoBox() {
    const v = T.view && T.view.players[HUMAN_ID];
    const cards = v && v.inHand && v.cards;
    el.infoHand.textContent = cards ? E.scoreHand(cards).label : '';
    updateEquity();
  }

  function updateEquity() {
    const v = T.view && T.view.players[HUMAN_ID];
    if (!v || !v.inHand || !v.cards || v.folded) {
      el.eqWin.textContent = '–';
      el.eqTie.textContent = '–';
      return;
    }
    const n = Object.entries(T.view.players).filter(([id, q]) => id !== HUMAN_ID && q.inHand && !q.folded).length;
    const eq = AI.equity(v.cards, n, { iterations: 2000 });
    el.eqWin.textContent = pct(eq.win);
    el.eqTie.textContent = pct(eq.tie);
  }

  function showSessionXp() {
    el.tableXpValue.textContent = `+${fmt(T.sessionXp)} XP`;
    if (!el.tableXp.classList.contains('show')) el.tableXp.classList.add('show');
    else anim(el.tableXp, [{ transform: 'translateY(-3px)' }, { transform: 'none' }], { duration: 220 });
  }

  // --- flights ---------------------------------------------------------------------------------

  function rectOf(node) {
    const r = node && node.getBoundingClientRect();
    return r && r.width > 0 ? r : null;
  }

  function potRect() {
    return rectOf(el.potAmount) || rectOf(el.deckTop) || rectOf(el.middle);
  }

  /**
   * A card back flies from the deck to its slot, scaling from deck size to slot size. A tiny
   * (opponent) card is built at deck size with the deck's back and shrinks on the way, so the deck
   * never shows a blown-up, coarse-striped back; your cards are built at their own size.
   */
  function flyCard(from, target, delay, tiny) {
    const to = rectOf(target);
    if (!from || !to) return Promise.resolve();
    const base = tiny ? from : to;
    const f = div('fly fly-card');
    f.style.width = `${base.width}px`;
    f.style.height = `${base.height}px`;
    f.style.borderRadius = tiny ? '18% / 13%' : getComputedStyle(target).borderRadius; // tiny: the deck's corner, scaling along
    const at = (r) => `translate(${r.left}px, ${r.top}px) scale(${r.width / base.width}, ${r.height / base.height})`;
    f.style.transform = at(to);
    el.fx.appendChild(f);
    return anim(f, [{ transform: at(from) }, { transform: at(to) }],
      { duration: 220, delay, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'both' }).then(() => f.remove());
  }

  /** A bet bubble slides to the pot and shrinks away. */
  function flyBubble(b, to) {
    const r = rectOf(b);
    if (!r || !to || reduced()) return Promise.resolve();
    const f = b.cloneNode(true);
    f.removeAttribute('id');
    f.hidden = false;
    f.classList.add('fly', 'fly-chip');
    f.style.height = `${r.height}px`;
    f.style.minWidth = `${r.width}px`;
    el.fx.appendChild(f);
    const x = to.left + to.width / 2 - r.width / 2;
    const y = to.top + to.height / 2 - r.height / 2;
    return anim(f, [
      { transform: `translate(${r.left}px, ${r.top}px)`, opacity: 1 },
      { transform: `translate(${x}px, ${y}px) scale(.5)`, opacity: 0 },
    ], { duration: 220, easing: 'ease-in', fill: 'forwards' }).then(() => f.remove());
  }

  /** The pot (or a share of it) travels to a winner. */
  function flyChip(from, target, amount) {
    const to = rectOf(target);
    if (!from || !to || reduced()) return Promise.resolve();
    const f = div('bubble num fly fly-chip', fmtAmt(amount));
    f.style.height = '24px';
    el.fx.appendChild(f);
    const w = f.offsetWidth || 40;
    const x0 = from.left + from.width / 2 - w / 2;
    const y0 = from.top + from.height / 2 - 12;
    const x1 = to.left + to.width / 2 - w / 2;
    const y1 = to.top + to.height / 2 - 12;
    return anim(f, [
      { transform: `translate(${x0}px, ${y0}px) scale(.9)`, opacity: 0 },
      { transform: `translate(${x0}px, ${y0}px)`, opacity: 1, offset: 0.15 },
      { transform: `translate(${x1}px, ${y1}px) scale(.7)`, opacity: 0.2 },
    ], { duration: 450, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }).then(() => f.remove());
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
      showBubble(ev.playerId, ev.amount);
      countTo(stackEl(ev.playerId), v.stack, 450);
    }
    const me = T.view.players[HUMAN_ID];
    if (me && me.inHand && me.allIn) { T.actionMode = 'allin'; refreshActions(); }
    await sleep(520);
    if (!alive(token)) return;
    await sweepBets(total, token);
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
    const slots = {};
    for (const id of ids) slots[id] = makeSlots(id);
    const from = rectOf(el.deckTop);
    const flights = [];
    if (!reduced() && dur(220) >= 1 && from) {
      let k = 0;
      for (let round = 0; round < 3; round++) {
        for (const id of ids) {
          const target = slots[id][round];
          flights.push(flyCard(from, target, 40 * k++, id !== HUMAN_ID).then(() => { target.style.opacity = ''; }));
        }
      }
      await Promise.all(flights);
    }
    for (const id of ids) slots[id].forEach((n) => { n.style.opacity = ''; });
    if (!alive(token)) return;
    if (ids.includes(HUMAN_ID)) {
      const v = T.view.players[HUMAN_ID];
      await Promise.all(slots[HUMAN_ID].map((n, i) => flip(n, () => paintFace(n, v.cards[i], 'big'), 80 * i)));
      updateInfoBox();
      anim(el.infoHand, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    } else {
      updateEquity();
    }
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
    if (a.added > 0) showBubble(id, v.bet);
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
      showLabel(id, labelFor(a));
      if (a.type === 'fold') {
        setSeatState(id);
        const minis = miniCards(id);
        minis.forEach((m) => anim(m, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 200, fill: 'forwards' }));
        setTimeout(() => minis.forEach((m) => m.remove()), dur(220));
      }
    }
    if (a.type === 'fold') updateEquity();
    await sleep(id === HUMAN_ID ? 260 : 380);
  }

  /** Round end: every bubble slides into the pot, then the pot counts up. */
  async function sweepBets(newPot, token) {
    const to = potRect();
    const flights = [];
    for (const [id, v] of Object.entries(T.view.players)) {
      const b = bubbleEl(id);
      if (b && !b.hidden) flights.push(flyBubble(b, to));
      hideBubble(id);
      v.bet = 0;
    }
    T.view.pot = newPot;
    await Promise.all(flights);
    if (!alive(token)) return;
    countTo(el.potAmount, newPot, 600);
    await sleep(flights.length ? 300 : 0);
  }

  /** A win is a "real" win unless it only returns a player's own uncalled chips. */
  function isRealWin(w, scores, best) {
    const v = T.view.players[w.playerId];
    return (scores[w.playerId] && scores[w.playerId].points === best) || w.amount > v.committed;
  }

  async function playShowdown(sd, wins, sv, token) {
    T.hand.result = sv ? 'svara' : 'showdown';
    // No more decisions in this deal. If a svara you play in follows, the hand isn't over for
    // you: keep the idle bet row instead of announcing the next hand.
    const mySvara = !!sv && sv.participants.includes(HUMAN_ID);
    T.actionMode = !mySvara ? 'wait' : T.view.players[HUMAN_ID].stack > 0 ? 'bet' : 'allin';
    refreshActions();
    const ids = Object.keys(sd.cards);
    const flips = [];
    for (const id of ids) {
      const v = T.view.players[id];
      v.cards = sd.cards[id].map((c) => E.parseCard(c.id));
      if (id === HUMAN_ID) continue;
      let minis = miniCards(id);
      if (minis.length !== 3) minis = makeSlots(id).map((m) => { m.style.opacity = ''; return m; });
      minis.forEach((m, i) => flips.push(flip(m, () => paintFace(m, v.cards[i], 'mini'))));
    }
    await Promise.all(flips);
    if (!alive(token)) return;
    await sleep(700);
    if (!alive(token)) return;

    const best = Math.max(...ids.map((id) => sd.scores[id].points));
    const winners = new Set(wins.filter((w) => isRealWin(w, sd.scores, best)).map((w) => w.playerId));
    const tied = new Set(sv ? sv.participants : []);
    const bright = new Set([...winners, ...tied]);
    for (const id of ids) {
      const used = new Set(sd.scores[id].usedCardIds);
      const nodes = id === HUMAN_ID ? heroCards() : miniCards(id);
      nodes.forEach((n) => n.classList.toggle('dim', !bright.has(id) || !used.has(n.dataset.card)));
      const se = seatEl(id);
      if (se) {
        se.root.classList.toggle('won', winners.has(id));
        se.root.classList.toggle('lost', !bright.has(id));
      }
    }
    const top = [...bright].map((id) => sd.scores[id]).sort((a, b) => b.points - a.points)[0];
    if (top) {
      el.pill.textContent = top.label;
      el.pill.hidden = false;
      anim(el.pill, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 160 });
    }
    el.table.dataset.result = T.hand.result;
    await sleep(600);
    if (!alive(token)) return;
    if (wins.length) await playWins(wins, winners);
  }

  /** Pay pots: the pot counts down while each winner's stack counts up in green. */
  async function playWins(wins, real) {
    const from = potRect();
    const jobs = [];
    let pot = T.view.pot;
    for (const w of wins) {
      const v = T.view.players[w.playerId];
      v.stack += w.amount;
      pot -= w.amount;
      const counts = real ? real.has(w.playerId) : true;
      if (w.uncontested) T.hand.result = 'uncontested';
      if (w.playerId === HUMAN_ID && counts) {
        T.hand.humanPots += 1;
        T.hand.humanWon += w.amount;
      }
      const se = seatEl(w.playerId);
      if (se && counts) {
        se.root.classList.add('won');
        anim(se.avatar.parentNode, [{ transform: 'none' }, { transform: 'scale(1.12)' }, { transform: 'none' }], { duration: 420, delay: 300 });
      }
      jobs.push(flyChip(from, w.playerId === HUMAN_ID ? el.infoBox : stackEl(w.playerId), w.amount));
      jobs.push(countTo(stackEl(w.playerId), v.stack, 1000, { tone: true }));
    }
    T.view.pot = pot;
    jobs.push(countTo(el.potAmount, pot, 1000));
    if (T.hand.result) el.table.dataset.result = T.hand.result;
    await Promise.all(jobs);
  }

  async function playSvara(ev) {
    T.svaras += 1;
    el.table.dataset.svaras = String(T.svaras);
    T.view.svara = { pot: ev.svaraPot, cost: ev.joinCost, participants: ev.participants.slice() };
    el.svaraSub.textContent = `Банка ${fmt(ev.svaraPot)} · Влизане ${fmt(ev.joinCost)}`;
    el.pill.hidden = true;
    el.middle.classList.add('svara');
    el.banner.hidden = false;
    el.table.dataset.result = 'svara';
    if (reduced()) {
      await anim(el.banner, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    } else {
      await anim(el.banner, [
        { transform: 'scale(.6)', opacity: 0 },
        { transform: 'scale(1.08)', opacity: 1, offset: 0.7 },
        { transform: 'scale(1)', opacity: 1 },
      ], { duration: 300, easing: 'cubic-bezier(.2,.8,.3,1.2)' });
      await anim(el.banner, [
        { transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' },
        { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-3px)' },
        { transform: 'translateX(0)' },
      ], { duration: 240, easing: 'linear' });
    }
    await sleep(ev.pending && ev.pending.length ? 700 : 1500);
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
      if (id !== HUMAN_ID) showLabel(id, 'Влиза');
    } else if (id !== HUMAN_ID) {
      showLabel(id, 'Отказва');
    }
    await sleep(id === HUMAN_ID ? 200 : 420);
  }

  async function playSvaraStart(ev, token) {
    const parts = new Set(ev.participants);
    await anim(el.banner, [{ opacity: 1 }, { opacity: 0 }], { duration: 180 });
    if (!alive(token)) return;
    el.banner.hidden = true;
    el.middle.classList.remove('svara');
    el.pill.hidden = true;
    el.table.dataset.result = '';
    // the old cards are thrown in
    const old = heroCards();
    for (let s = 1; s < SEATS; s++) if (T.seatEls[s]) old.push(...T.seatEls[s].cards.children);
    await Promise.all(old.map((n) => anim(n, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' })));
    old.forEach((n) => n.remove());
    if (!alive(token)) return;
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
    await sleep(250);
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
    fitLabels();
  }

  /** "Плащам 1 000" stays on one line when it fits; otherwise the amount drops below. */
  function fitLabels() {
    const btns = [el.btns.call, el.btns.raise, el.btns.allin].filter((b) => !b.hidden);
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
    });
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
    el.infoBox.addEventListener('click', () => el.infoBox.classList.toggle('page-b'));
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

  function startLoop() {
    const token = ++T.token;
    T.errors = 0;
    runLoop(token);
  }

  async function runLoop(token) {
    await sleep(400); // let the empty table show before the first deal
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
    if (se) se.root.classList.add('thinking');
    const me = T.view.players[HUMAN_ID];
    const humanLive = me && me.inHand && !me.folded;
    await sleep(rand(700, 1300) * (humanLive ? 1 : 0.6));
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
      leaderboard: $('leaderboard'),
      stakesBankroll: $('stakes-bankroll'),
      stakesValue: $('stakes-value'),
      buyinValue: $('buyin-value'),
      stakesNote: $('stakes-note'),
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
      deckTop: $('deck-top'),
      pill: $('hand-pill'),
      potLabel: $('pot-label'),
      potAmount: $('pot-amount'),
      banner: $('svara-banner'),
      svaraSub: $('svara-sub'),
      heroBubble: $('hero-bubble'),
      actions: $('actions'),
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
      fx: $('fx'),
      toast: $('toast'),
    });
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
    el.modes.addEventListener('scroll', () => { if (!modeRaf) modeRaf = requestAnimationFrame(updateModeScale); }, { passive: true });
    window.addEventListener('resize', () => {
      if (!modeRaf) modeRaf = requestAnimationFrame(updateModeScale);
      if (screenName === 'table') fitLabels();
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
