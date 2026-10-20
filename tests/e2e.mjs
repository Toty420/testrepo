// Playwright playthrough of the built index.html (node tests/e2e.mjs, after npm run build).
// Home → stakes → table at 390×844 (dpr 2): 30+ hands of random legal play, two rigged svaras
// (you in it; you outside it, through the join sheet), one all-in, the leave sheet and the
// bankroll check. Then fit checks at 375×667 and 440×956 and a smoke load of the artifact
// fragment. Screenshots go to the scratchpad. Exits non-zero on any failure or console error.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_URL = pathToFileURL(join(root, 'index.html')).href;
const FRAGMENT_URL = pathToFileURL(join(root, 'dist/svara-artifact.html')).href;
const SHOTS = process.env.SVARA_SHOTS ||
  '/tmp/claude-0/-home-user-testrepo/45e080a8-3aa6-5ddf-b173-73cd179b5b6b/scratchpad/shots/ui';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const HANDS = 30;
const SPEED = 0.05;

mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const log = (...a) => console.log(...a);
function check(cond, msg) {
  if (cond) return;
  failures++;
  console.error(`  ✗ ${msg}`);
}
const digits = (s) => Number(String(s).replace(/[^\d]/g, ''));

async function launch() {
  try {
    return await chromium.launch();
  } catch (e) {
    return chromium.launch({ executablePath: CHROME });
  }
}

/** A phone-sized page that records console errors, page errors and any network request. */
async function phone(browser, width, height, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...extra });
  const page = await ctx.newPage();
  page.problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && m.text().includes('[svara]'))) page.problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => page.problems.push(`page error: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:')) page.problems.push(`network request: ${u}`);
  });
  return { ctx, page };
}

async function fresh(page, url = PAGE_URL) {
  await page.goto(url);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  await page.goto(url);
  await page.waitForFunction(() => window.__svaraDebug && window.__svaraDebug.screen() === 'home');
}

const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const screen = (page) => page.evaluate(() => window.__svaraDebug.screen());

/** What the UI is waiting for: 'turn' | 'next' | 'svara' | 'busted' | 'banner'. */
async function waitUi(page, timeout = 30000) {
  const h = await page.waitForFunction(() => {
    const open = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.classList.contains('open'); };
    if (open('sheet-busted')) return 'busted';
    if (open('sheet-svara')) return 'svara';
    const banner = document.getElementById('svara-banner');
    if (window.__wantBanner && !banner.hidden) return 'banner';
    if (document.getElementById('screen-table').dataset.turn === '1' && !open('sheet-raise')) return 'turn';
    const n = document.getElementById('btn-next');
    if (!n.hidden && !n.disabled) return 'next';
    return false;
  }, null, { timeout, polling: 15 });
  return h.jsonValue();
}

async function startFromHome(page) {
  if (await page.isVisible('#btn-free-chips')) await page.click('#btn-free-chips');
  await page.click('#mode-ai');
  await page.waitForFunction(() => window.__svaraDebug.screen() === 'stakes');
  if (await page.isDisabled('#btn-start')) {
    await page.focus('#stakes-slider');
    await page.keyboard.press('Home');
  }
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__svaraDebug.screen() === 'table' && !!window.__svaraDebug.game);
  await page.evaluate((s) => window.__svaraDebug.setSpeed(s), SPEED);
}

/** Busted: buy back in, or (bankroll too small) go home and sit down again. */
async function rebuyOrRestart(page) {
  if (!(await page.isDisabled('#btn-rebuy'))) return page.click('#btn-rebuy');
  await page.click('#btn-busted-home');
  await page.waitForFunction(() => window.__svaraDebug.screen() === 'home');
  return startFromHome(page);
}

/** Layout checks: nothing scrolls, every table block is inside the viewport. */
async function fitProblems(page, selectors) {
  return page.evaluate((sels) => {
    const out = [];
    const W = innerWidth;
    const H = innerHeight;
    const de = document.documentElement;
    if (de.scrollWidth > W + 0.5) out.push(`horizontal scroll (${de.scrollWidth} > ${W})`);
    if (de.scrollHeight > H + 0.5) out.push(`vertical scroll (${de.scrollHeight} > ${H})`);
    if (document.body.scrollWidth > W + 0.5) out.push(`body wider than viewport (${document.body.scrollWidth})`);
    for (const sel of sels) {
      for (const n of document.querySelectorAll(sel)) {
        const r = n.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.left < -0.5 || r.right > W + 0.5 || r.top < -0.5 || r.bottom > H + 0.5) {
          out.push(`${sel} outside viewport: ${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}`);
        }
      }
    }
    return out;
  }, selectors);
}
const TABLE_PARTS = ['.t-top', '#opps', '.seat', '#deck', '#pot', '#actions', '#actions .act:not([hidden])', '#hand', '#info-box'];

// Mutually disjoint 10-point hands (no joker, no two aces) for the bots outside a rigged tie.
const WEAK = [['8d', '9c', '10s'], ['8h', '9d', '10c'], ['7d', '8c', 'Js'], ['7h', 'Qs', '10d'], ['9h', 'Jd', '8s']];

async function botIds(page) {
  return page.evaluate(() => window.__svaraDebug.getState().players.filter((p) => !p.isHuman).map((p) => p.id));
}

/** Rig the next deal: you get `me`, the first bots get `tied` hands, the rest weak hands. */
async function rigNext(page, me, tied) {
  const bots = await botIds(page);
  const hands = { me };
  tied.forEach((h, i) => { hands[bots[i]] = h; });
  const taken = new Set([...me, ...tied.flat()]);
  const weak = WEAK.filter((h) => !h.some((c) => taken.has(c)));
  bots.slice(tied.length).forEach((id, i) => { hands[id] = weak[i]; });
  await page.evaluate((h) => window.__svaraDebug.rig(h), hands);
}

// ---------------------------------------------------------------------------------------------

async function mainFlow(browser) {
  log('▸ 390×844: home → stakes → table');
  const { ctx, page } = await phone(browser, 390, 844);
  await fresh(page);
  check(digits(await page.textContent('#home-bankroll')) === 5000, 'starting bankroll is 5 000');
  check((await page.textContent('#home-bankroll')).includes(' '), 'bankroll uses a narrow no-break space');
  check((await page.locator('#leaderboard li').count()) === 13, 'leaderboard lists 12 bots and you');
  await page.waitForTimeout(250);
  await shot(page, 'home');
  check((await fitProblems(page, ['.home-top', '#home-bankroll', '.nav'])).length === 0, 'home fits without horizontal scroll');

  await page.click('#mode-online');
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'));
  check((await page.textContent('#toast')) === 'Скоро', 'locked mode shows the "Скоро" toast');
  await page.click('#nav-profile');
  check((await page.textContent('#toast')) === 'Скоро', 'profile tab shows "Скоро"');

  await page.click('#mode-ai');
  await page.waitForFunction(() => window.__svaraDebug.screen() === 'stakes');
  await page.waitForTimeout(300);
  await shot(page, 'stakes');
  await page.click('#stakes-slider .tick-cell:nth-child(1)');
  check((await page.textContent('#stakes-value')) === '1 / 2', 'tap on the first tick picks 1 / 2');
  check((await page.textContent('#buyin-value')) === '40 / 200', 'buy-in 40 / 200 at 1 / 2');
  await page.focus('#stakes-slider');
  await page.keyboard.press('End');
  check((await page.textContent('#stakes-value')) === '25K / 50K', 'End key picks 25K / 50K');
  check(await page.isDisabled('#btn-start'), 'start is disabled when the buy-in is unaffordable');
  check(await page.evaluate(() => document.getElementById('screen-stakes').classList.contains('unaffordable')), 'unaffordable state is shown');
  await shot(page, 'stakes-unaffordable');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  check((await page.textContent('#stakes-value')) === '5 / 10', 'arrow key moves to 5 / 10');
  check((await page.textContent('#buyin-value')) === '200 / 1K', 'buy-in 200 / 1K at 5 / 10');
  check(!(await page.isDisabled('#btn-start')), 'start is enabled at 5 / 10');

  await page.click('#btn-start');
  await page.waitForFunction(() => window.__svaraDebug.screen() === 'table' && !!window.__svaraDebug.game);
  await page.evaluate((s) => window.__svaraDebug.setSpeed(s), SPEED);
  let buyIns = 1000;
  let freeChips = 0;
  check((await page.evaluate(() => window.__svaraDebug.profile().bankroll)) === 4000, 'buy-in of 1 000 leaves 4 000 in the bankroll');

  // ---- the hand loop ----
  const stats = { hands: 0, turns: 0, raises: 0, sheetRaises: 0, folds: 0, rebuys: 0, svaraJoins: 0, showdowns: 0 };
  const shotsTaken = new Set();
  let plan = null; // special hand in progress: { kind, tries, svarasBefore, strategy }
  let allInDone = false;
  let wantAllIn = false;
  let svaraPart = false; // svara with you as a participant has happened
  let svaraPrompt = false; // the join sheet has been used
  let lastHandSeen = -1;
  let stuckGuard = 0;

  const svaraCount = () => page.evaluate(() => Number(document.getElementById('screen-table').dataset.svaras || 0));

  async function act(strategy) {
    const L = await page.evaluate(() => window.__svaraDebug.game.legalActions('me'));
    check(L.isTurn, 'buttons are enabled only on your turn');
    const allInOnly = await page.evaluate(() => document.getElementById('actions').dataset.mode === 'allin-only');
    let target;
    if (strategy === 'fold') target = '#btn-fold';
    else if (strategy === 'call') target = allInOnly ? '#btn-allin' : '#btn-call';
    else if (strategy === 'allin') {
      if (allInOnly) target = '#btn-allin';
      else if (L.canRaise) {
        await page.click('#btn-raise-more');
        await page.waitForSelector('#sheet-raise.open');
        await page.click('#preset-allin');
        check((await page.textContent('#btn-raise-confirm')).startsWith('Ва банк'), 'all-in preset sets "Ва банк N"');
        await page.click('#btn-raise-confirm');
        target = null;
      } else if (L.canAllIn) target = '#btn-raise'; // short stack: the raise slot is "Ва банк"
      else target = '#btn-call';
    } else {
      const r = Math.random();
      if (allInOnly) target = r < 0.35 ? '#btn-fold' : '#btn-allin';
      else if (r < (L.canCheck ? 0.04 : 0.16)) target = '#btn-fold';
      else if (r < 0.8 || !L.canRaise) target = '#btn-call';
      else if (r < 0.9) target = '#btn-raise';
      else {
        await page.click('#btn-raise-more');
        await page.waitForSelector('#sheet-raise.open');
        await page.waitForTimeout(260);
        const preset = ['#preset-min', '#preset-half', '#preset-pot'][Math.floor(Math.random() * 3)];
        await page.click(preset);
        await page.focus('#raise-slider');
        await page.keyboard.press('ArrowRight');
        if (!shotsTaken.has('raise')) { shotsTaken.add('raise'); await shot(page, 'raise-sheet'); }
        const label = await page.textContent('#btn-raise-confirm');
        check(/^(Вдигам до|Залагам|Ва банк) \d/.test(label.replace(/ /g, '')), `raise confirm label "${label}"`);
        await page.click('#btn-raise-confirm');
        stats.sheetRaises++;
        target = null;
      }
    }
    if (target) {
      check(!(await page.isDisabled(target)), `${target} is enabled for the chosen action`);
      await page.click(target);
    }
    if (target === '#btn-fold') stats.folds++;
    if (target === '#btn-raise') stats.raises++;
    stats.turns++;
    await page.waitForFunction(() => document.getElementById('screen-table').dataset.turn !== '1');
    const live = await page.evaluate(() => Array.from(document.querySelectorAll('#actions .act:not([hidden])')).filter((b) => !b.disabled).map((b) => b.id));
    check(live.length === 0, `no action button is enabled after you act (${live})`);
  }

  while (stats.hands < HANDS || !allInDone || !svaraPart || !svaraPrompt) {
    if (++stuckGuard > 4000) throw new Error('hand loop did not finish');
    if (stats.hands > HANDS + 40) throw new Error('could not force the rigged svaras / all-in');
    let ui;
    try {
      ui = await waitUi(page);
    } catch (e) {
      const st = await page.evaluate(() => JSON.stringify({ s: window.__svaraDebug.getState(), mode: document.getElementById('actions').dataset.state }));
      throw new Error(`UI got stuck: ${st.slice(0, 1500)}`);
    }
    if (ui === 'banner') {
      await page.evaluate(() => { window.__wantBanner = false; });
      await shot(page, 'svara-banner');
      shotsTaken.add('banner');
      await page.evaluate((s) => window.__svaraDebug.setSpeed(s), SPEED);
      continue;
    }
    if (ui === 'turn') {
      const hand = await page.evaluate(() => window.__svaraDebug.getState().handNumber);
      if (!shotsTaken.has('table') && hand >= 2) {
        shotsTaken.add('table');
        await page.waitForTimeout(150);
        await shot(page, 'table-mid-hand');
        const fit = await fitProblems(page, TABLE_PARTS);
        check(fit.length === 0, `table fits 390×844: ${fit.join('; ')}`);
        // the info box toggles between avatar + stack and the odds
        await page.click('#info-box');
        check(await page.evaluate(() => document.getElementById('info-box').classList.contains('page-b')), 'info box switches to the odds page');
        const odds = [await page.textContent('#eq-win'), await page.textContent('#eq-tie')];
        check(odds.every((t) => /^\d{1,3}%$/.test(t)), `odds read as percentages (${odds})`);
        await page.waitForTimeout(120);
        await shot(page, 'table-odds');
        await page.click('#info-box');
        check(!(await page.evaluate(() => document.getElementById('info-box').classList.contains('page-b'))), 'info box switches back');
      }
      let strategy = plan ? plan.strategy : 'random';
      if (!plan && wantAllIn && !allInDone) strategy = 'allin';
      await act(strategy);
      if (strategy === 'allin') {
        const me = await page.evaluate(() => window.__svaraDebug.getState().players.find((p) => p.id === 'me'));
        if (me.allIn || me.stack === 0) {
          allInDone = true;
          log(`  all-in done in hand ${hand}`);
        }
      }
      if (plan && plan.strategy === 'fold') plan.strategy = 'random'; // fold once, then you may join
      lastHandSeen = hand;
      continue;
    }
    if (ui === 'svara') {
      check((await page.textContent('#svara-title')).startsWith('Свара! Влез за'), 'svara sheet title');
      if (!shotsTaken.has('svara-sheet')) { shotsTaken.add('svara-sheet'); await page.waitForTimeout(250); await shot(page, 'svara-join-sheet'); }
      const join = plan && plan.kind === 'outside' ? true : Math.random() < 0.5;
      await page.click(join ? '#btn-svara-join' : '#btn-svara-decline');
      if (plan && plan.kind === 'outside') { svaraPrompt = true; log(`  joined a svara from outside (hand ${await page.evaluate(() => window.__svaraDebug.getState().handNumber)})`); }
      if (join) stats.svaraJoins++;
      await page.waitForFunction(() => document.getElementById('sheet-svara').hidden || !document.getElementById('sheet-svara').classList.contains('open'));
      continue;
    }
    if (ui === 'busted') {
      if (!(await page.isDisabled('#btn-rebuy'))) {
        const n = digits(await page.textContent('#btn-rebuy'));
        buyIns += n;
        stats.rebuys++;
        await page.click('#btn-rebuy');
      } else {
        await page.click('#btn-busted-home');
        await page.waitForFunction(() => window.__svaraDebug.screen() === 'home');
        if (await page.isVisible('#btn-free-chips')) freeChips += 1000;
        await startFromHome(page);
        buyIns += await page.evaluate(() => window.__svaraDebug.getState().players.find((p) => p.id === 'me').stack);
      }
      continue;
    }
    // ui === 'next': the hand is over
    stats.hands++;
    const result = await page.evaluate(() => document.getElementById('screen-table').dataset.result);
    if (result === 'showdown') {
      stats.showdowns++;
      if (!shotsTaken.has('showdown')) { shotsTaken.add('showdown'); await shot(page, 'showdown'); }
    }
    const state = await page.evaluate(() => window.__svaraDebug.getState());
    check(state.phase === 'hand-over' && state.pot === 0, 'hand-over with an empty pot');
    const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.seat')).map((s) => s.querySelector('.seat-stack').textContent));
    const engineStacks = state.players.filter((p) => !p.isHuman).sort((a, b) => a.seat - b.seat).map((p) => p.stack);
    check(shown.map(digits).join() === engineStacks.join(), `seat stacks match the engine (${shown.map(digits)} vs ${engineStacks})`);

    // A rigged hand just ended: did it do its job?
    if (plan) {
      await page.evaluate((s) => { window.__wantBanner = false; window.__svaraDebug.setSpeed(s); }, SPEED);
      const happened = (await svaraCount()) > plan.svarasBefore;
      if (plan.kind === 'inside' && happened) { svaraPart = true; log(`  svara with you in it (hand ${state.handNumber})`); }
      const ok = plan.kind === 'inside' ? svaraPart : svaraPrompt;
      if (!ok && plan.tries >= plan.maxTries) {
        check(false, `could not force a svara (${plan.kind}) in ${plan.tries} rigged hands`);
        svaraPart = true;
        svaraPrompt = true;
      }
      if (ok || plan.tries >= plan.maxTries) plan = null;
    }
    // Start (or retry) a rigged hand.
    const meStack = state.players.find((p) => p.id === 'me').stack;
    if (!plan && !svaraPart && stats.hands >= 3) plan = { kind: 'inside', tries: 0, maxTries: 5 };
    else if (!plan && svaraPart && !svaraPrompt && stats.hands >= 8 && meStack >= 100) plan = { kind: 'outside', tries: 0, maxTries: 10 };
    if (plan) {
      plan.tries++;
      plan.svarasBefore = await svaraCount();
      if (plan.kind === 'inside') {
        // 31 vs 31: you call everything, the tie makes a svara with you in it
        plan.strategy = 'call';
        await rigNext(page, ['Ah', 'Kh', 'Qh'], [['As', 'Ks', 'Qs']]);
        await page.evaluate(() => { window.__wantBanner = true; window.__svaraDebug.setSpeed(0.6); });
      } else {
        // two quiet 20-point hands tie; you fold first and then get the join sheet
        plan.strategy = 'fold';
        await rigNext(page, ['7s', '10h', 'Jc'], [['Kd', 'Qd', '8s'], ['Kh', 'Jh', '9s']]);
      }
    }
    if (stats.hands >= 12 && !allInDone) wantAllIn = true;
    if (stats.hands === 1) {
      // one hand done: the XP indicator must show
      const xp = await page.textContent('#table-xp-value');
      check(/^\+\d+ XP$/.test(xp.replace(/ /g, '')), `table XP reads "+N XP" (${xp})`);
    }
    await page.click('#btn-next');
  }
  log(`  ${JSON.stringify(stats)}`);
  check(stats.showdowns > 0, 'at least one showdown was played');
  check(shotsTaken.has('banner'), 'svara banner was seen');

  // ---- leave the table ----
  let ui = await waitUi(page);
  while (ui !== 'turn' && ui !== 'next') {
    if (ui === 'svara') await page.click('#btn-svara-decline');
    else if (ui === 'busted') { buyIns += digits(await page.textContent('#btn-rebuy')); await page.click('#btn-rebuy'); }
    else if (ui === 'banner') await page.evaluate(() => { window.__wantBanner = false; });
    ui = await waitUi(page);
  }
  const before = await page.evaluate(() => ({
    bankroll: window.__svaraDebug.profile().bankroll,
    stack: window.__svaraDebug.getState().players.find((p) => p.id === 'me').stack,
  }));
  check(before.bankroll === 5000 + freeChips - buyIns, `bankroll without the table = 5000 + free − buy-ins (${before.bankroll} vs ${5000 + freeChips - buyIns})`);
  await page.click('#btn-leave');
  await page.waitForSelector('#sheet-leave.open');
  await page.waitForTimeout(300);
  await shot(page, 'leave-sheet');
  check((await page.textContent('#leave-title')) === 'Сигурен ли си?', 'leave sheet title');
  await page.click('#btn-leave-stay');
  await page.waitForFunction(() => document.getElementById('sheet-leave').hidden);
  check((await screen(page)) === 'table', '"Остани" keeps you at the table');
  const stillStack = await page.evaluate(() => window.__svaraDebug.getState().players.find((p) => p.id === 'me').stack);
  await page.click('#btn-leave');
  await page.waitForSelector('#sheet-leave.open');
  await page.click('#btn-leave-confirm');
  await page.waitForFunction(() => window.__svaraDebug.screen() === 'home' && window.__svaraDebug.game === null);
  const expected = before.bankroll + stillStack;
  await page.waitForFunction((v) => Number(document.getElementById('home-bankroll').textContent.replace(/[^\d]/g, '')) === v, expected, { timeout: 8000 })
    .catch(() => {});
  const shownBankroll = digits(await page.textContent('#home-bankroll'));
  check(shownBankroll === expected, `home bankroll = bankroll + table stack (${shownBankroll} vs ${expected})`);
  check((await page.evaluate(() => window.__svaraDebug.profile().bankroll)) === expected, 'profile bankroll after leaving');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('svara.v1')));
  check(stored && stored.bankroll === expected, 'localStorage bankroll after leaving');
  check(stored && stored.handsPlayed >= HANDS && stored.xp >= stored.handsPlayed, `stored XP/hands (${JSON.stringify(stored)})`);
  check(Object.keys(stored).sort().join() === 'bankroll,biggestPot,handsPlayed,handsWon,xp', 'stored profile has exactly the spec fields');
  await page.waitForTimeout(400);
  await shot(page, 'home-after');

  // reload: the profile survives
  await page.reload();
  await page.waitForFunction(() => window.__svaraDebug && window.__svaraDebug.screen() === 'home');
  check(digits(await page.textContent('#home-bankroll')) === expected, 'bankroll survives a reload');

  check(page.problems.length === 0, `no console errors / page errors / network: ${page.problems.slice(0, 5).join(' | ')}`);
  await ctx.close();
}

async function sizeCheck(browser, width, height, opts = {}) {
  log(`▸ ${width}×${height}: fit checks${opts.reducedMotion ? ' (reduced motion, a few hands)' : ''}`);
  const { ctx, page } = await phone(browser, width, height, opts.reducedMotion ? { reducedMotion: 'reduce' } : {});
  await fresh(page);
  check((await fitProblems(page, ['.home-top', '#home-bankroll', '#modes .mode:first-child', '.nav'])).length === 0, `home fits ${width}×${height}`);
  await page.click('#mode-ai');
  await page.waitForFunction(() => window.__svaraDebug.screen() === 'stakes');
  await page.waitForTimeout(300);
  const sf = await fitProblems(page, ['.stakes-panel', '#stakes-slider', '#btn-start']);
  check(sf.length === 0, `stakes fits ${width}×${height}: ${sf.join('; ')}`);
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__svaraDebug.screen() === 'table' && !!window.__svaraDebug.game);
  await page.evaluate((s) => window.__svaraDebug.setSpeed(s), SPEED);
  let ui = await waitUi(page);
  let guard = 0;
  while (ui !== 'turn' && guard++ < 50) {
    if (ui === 'next') await page.click('#btn-next');
    else if (ui === 'svara') await page.click('#btn-svara-decline');
    else if (ui === 'busted') await rebuyOrRestart(page);
    ui = await waitUi(page);
  }
  await page.waitForTimeout(150);
  await shot(page, `table-${width}x${height}`);
  const fit = await fitProblems(page, TABLE_PARTS);
  check(fit.length === 0, `table fits ${width}×${height}: ${fit.join('; ')}`);
  const middle = await page.evaluate(() => {
    const m = document.getElementById('middle').getBoundingClientRect();
    const d = document.getElementById('deck').getBoundingClientRect();
    const p = document.getElementById('pot').getBoundingClientRect();
    return { ok: d.top >= m.top - 6 && p.bottom <= m.bottom + 1, m: Math.round(m.height) };
  });
  check(middle.ok, `deck and pot fit in the middle row (${middle.m}px tall)`);
  const canRaise = await page.evaluate(() => window.__svaraDebug.game.legalActions('me').canRaise);
  if (canRaise) {
    await page.click('#btn-raise-more');
    await page.waitForSelector('#sheet-raise.open');
    await page.waitForTimeout(300);
    const sheet = await page.evaluate(() => { const r = document.getElementById('sheet-raise').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight }; });
    check(sheet.top >= 0 && sheet.bottom <= sheet.h + 0.5, `raise sheet fits ${width}×${height}`);
    await shot(page, `raise-sheet-${width}x${height}`);
    await page.click('#btn-raise-cancel');
    await page.waitForFunction(() => document.getElementById('sheet-raise').hidden);
  }
  // a few more hands (check/call) to exercise the motion settings of this context
  let hands = 0;
  guard = 0;
  while (hands < (opts.hands || 0) && guard++ < 400) {
    ui = await waitUi(page);
    if (ui === 'turn') {
      const allInOnly = await page.evaluate(() => document.getElementById('actions').dataset.mode === 'allin-only');
      await page.click(allInOnly ? '#btn-allin' : '#btn-call');
      await page.waitForFunction(() => document.getElementById('screen-table').dataset.turn !== '1');
    } else if (ui === 'next') { hands++; await page.click('#btn-next'); }
    else if (ui === 'svara') await page.click('#btn-svara-join');
    else if (ui === 'busted') await rebuyOrRestart(page);
  }
  if (opts.hands) check(hands === opts.hands, `played ${opts.hands} hands at ${width}×${height}`);
  check(page.problems.length === 0, `no console errors at ${width}×${height}: ${page.problems.slice(0, 5).join(' | ')}`);
  await ctx.close();
}

async function fragmentSmoke(browser) {
  log('▸ dist/svara-artifact.html loads');
  const { ctx, page } = await phone(browser, 390, 844);
  await page.goto(FRAGMENT_URL);
  await page.waitForFunction(() => window.__svaraDebug && window.__svaraDebug.screen() === 'home');
  check((await page.title()) === 'Свара', 'artifact title is Свара');
  check(page.problems.length === 0, `artifact page has no errors: ${page.problems.join(' | ')}`);
  await ctx.close();
}

const browser = await launch();
try {
  await mainFlow(browser);
  await sizeCheck(browser, 375, 667);
  await sizeCheck(browser, 440, 956, { reducedMotion: true, hands: 4 });
  await fragmentSmoke(browser);
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await browser.close();
}
log(`screenshots: ${SHOTS}`);
if (failures) {
  console.error(`e2e FAILED (${failures} problem${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
log('e2e passed');
