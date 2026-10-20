import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');
const AI = require('../src/ai.js');

const cards = (s) => s.split(' ').map(E.parseCard);
const NAMES = Object.keys(AI.PERSONALITIES);

function mkPlayers(stacks) {
  return stacks.map((stack, i) => ({ id: `p${i}`, name: `P${i}`, avatar: '🙂', stack, isHuman: i === 0 }));
}

/** deckProvider: give `hands[id]` to those players, random cards to the rest. */
function rigHands(hands, rng) {
  return (info) => {
    const used = new Set(Object.values(hands).flatMap((h) => h.split(' ')));
    const rest = E.shuffle(E.newDeck().map((c) => c.id).filter((id) => !used.has(id)), rng);
    const deck = [];
    for (const id of info.order) deck.push(...(hands[id] ? hands[id].split(' ') : rest.splice(0, 3)));
    return deck.concat(rest);
  };
}

/** Check a decision against the legal actions. */
function assertLegal(action, L, bb, label = '') {
  assert.ok(action && typeof action.type === 'string', `${label} action shape`);
  switch (action.type) {
    case 'fold': assert.ok(L.canFold, `${label} fold`); break;
    case 'check': assert.ok(L.canCheck, `${label} check`); break;
    case 'call': assert.ok(L.canCall, `${label} call`); break;
    case 'allin': assert.ok(L.canAllIn, `${label} allin`); break;
    case 'raise':
      assert.ok(L.canRaise, `${label} raise allowed`);
      assert.ok(Number.isInteger(action.amount), `${label} integer raise`);
      assert.ok(action.amount >= L.minRaiseTo && action.amount <= L.maxRaiseTo, `${label} raise in range`);
      if (action.amount < L.maxRaiseTo && L.minRaiseTo % bb === 0) {
        assert.equal(action.amount % bb, 0, `${label} raise rounded to bb`);
      }
      break;
    default: assert.fail(`${label} unknown type ${action.type}`);
  }
}

// --- equity ------------------------------------------------------------------

describe('equity', () => {
  test('three 7s cannot lose (and cannot tie)', () => {
    for (const hand of ['7s 7h 7d', '7c 7h 7d']) {
      for (const n of [1, 5, 9]) {
        const eq = AI.equity(cards(hand), n, { rng: E.makeRng(n) });
        assert.equal(eq.win, 1);
        assert.equal(eq.tie, 0);
      }
    }
  });

  test('a 10-point hand against 5 opponents almost never wins', () => {
    const eq = AI.equity(cards('8s 9h 10d'), 5, { rng: E.makeRng(3) });
    assert.ok(eq.win < 0.02, `win ${eq.win}`);
    assert.ok(eq.win + eq.tie < 0.05);
  });

  test('stronger hands have more equity; more opponents means less', () => {
    const rng = E.makeRng(11);
    const e = (h, n) => AI.equity(cards(h), n, { iterations: 4000, rng }).win;
    const strong = e('As Ah Ad', 5);
    const good = e('Ah Kh Qh', 5);
    const mid = e('Ah Kh 9s', 5);
    const weak = e('8s 9h 10d', 5);
    assert.ok(strong > good && good > mid && mid > weak, [strong, good, mid, weak].join(' '));
    assert.ok(strong > 0.95);
    assert.ok(e('Ah Kh 9s', 1) > e('Ah Kh 9s', 3));
  });

  test('matches exact enumeration heads-up', () => {
    const deck = E.newDeck();
    for (const hand of ['Ah Kh 9s', 'Kd Qd 10s', '9h 9d 7c']) {
      const mine = cards(hand);
      const ids = new Set(mine.map((c) => c.id));
      const rest = deck.filter((c) => !ids.has(c.id));
      const myPts = E.scoreHand(mine).points;
      let win = 0, tie = 0, n = 0;
      for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) for (let k = j + 1; k < rest.length; k++) {
        const pts = E.scoreHand([rest[i], rest[j], rest[k]]).points;
        n++;
        if (myPts > pts) win++; else if (myPts === pts) tie++;
      }
      const eq = AI.equity(mine, 1, { iterations: 30000, rng: E.makeRng(5) });
      assert.ok(Math.abs(eq.win - win / n) < 0.015, `${hand}: ${eq.win} vs ${win / n}`);
      assert.ok(Math.abs(eq.tie - tie / n) < 0.01, `${hand}: tie ${eq.tie} vs ${tie / n}`);
    }
  });

  test('basic contract: reproducible with a seed, no opponents = certain win, jokerWild option', () => {
    const a = AI.equity(cards('Ah Kh 9s'), 4, { rng: E.makeRng(9) });
    const b = AI.equity(cards('Ah Kh 9s'), 4, { rng: E.makeRng(9) });
    assert.deepEqual(a, b);
    assert.ok(a.win >= 0 && a.tie >= 0 && a.win + a.tie <= 1);
    assert.deepEqual(AI.equity(cards('8s 9h 10d'), 0), { win: 1, tie: 0 });
    // A♥ K♥ 7♣ is 32 with the joker, only 21 without
    const wild = AI.equity(cards('Ah Kh 7c'), 5, { rng: E.makeRng(1), iterations: 3000 }).win;
    const plain = AI.equity(cards('Ah Kh 7c'), 5, { rng: E.makeRng(1), iterations: 3000, jokerWild: false }).win;
    assert.ok(wild > 0.9 && plain < 0.5, `${wild} ${plain}`);
    assert.ok(AI.equity(['Ah', 'Kh', '9s'], 2).win > 0); // card ids work too
    assert.throws(() => AI.equity(cards('Ah Kh'), 2), /3 cards/);
  });

  test('bettors option: opponents who bet hold hands from a range, with a bluff share', () => {
    const opts = (extra) => ({ rng: E.makeRng(3), iterations: 4000, ...extra });
    const random = AI.equity(cards('Kd Qd 9s'), 1, opts()).win; // 20 points
    // Against a strict 25+ range 20 points can never win or tie.
    assert.deepEqual(AI.equity(cards('Kd Qd 9s'), 1, opts({ bettors: 1, minPoints: 25, bluffMix: 0 })), { win: 0, tie: 0 });
    // With 20% bluffs it wins about a fifth as often as against a random hand.
    const mixed = AI.equity(cards('Kd Qd 9s'), 1, opts({ bettors: 1, minPoints: 25, bluffMix: 0.2 })).win;
    assert.ok(Math.abs(mixed - 0.2 * random) < 0.03, `${mixed} vs ${random}`);
    // Only the bettors are narrowed: the other opponents still hold random hands.
    const oneOfThree = AI.equity(cards('As Ad 9h'), 3, opts({ bettors: 1, minPoints: 23, bluffMix: 0 }));
    assert.ok(oneOfThree.win === 0 && oneOfThree.tie === 0);
    const strong = AI.equity(cards('As Ah Ad'), 5, opts({ bettors: 5, minPoints: 25 }));
    assert.ok(strong.win > 0.9, `AAA vs five 25+ ranges ${strong.win}`);
    assert.deepEqual(AI.equity(cards('7s 7h 7d'), 5, opts({ bettors: 5, minPoints: 30, bluffMix: 0 })), { win: 1, tie: 0 });
  });

  test('1200 iterations against 5 opponents take well under 30 ms', () => {
    AI.equity(cards('Ah Kh 9s'), 5); // warm-up (builds the lookup table)
    const rng = E.makeRng(1);
    let worst = 0;
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      AI.equity(cards('Kd Qd 10s'), 5, { iterations: 1200, rng });
      worst = Math.max(worst, performance.now() - t);
    }
    const avg = (performance.now() - t0) / 20;
    assert.ok(avg < 10, `average ${avg.toFixed(2)} ms`);
    assert.ok(worst < 30, `worst ${worst.toFixed(2)} ms`);
  });
});

// --- personalities -----------------------------------------------------------

test('PERSONALITIES: rock, tag, lag, fish, maniac with tightness/aggression/bluff in [0, 1]', () => {
  for (const name of ['rock', 'tag', 'lag', 'fish', 'maniac']) {
    const p = AI.PERSONALITIES[name];
    assert.ok(p, name);
    for (const k of ['tightness', 'aggression', 'bluff']) assert.ok(p[k] >= 0 && p[k] <= 1, `${name}.${k}`);
  }
  assert.ok(AI.PERSONALITIES.rock.tightness > AI.PERSONALITIES.fish.tightness);
  assert.ok(AI.PERSONALITIES.maniac.aggression > AI.PERSONALITIES.rock.aggression);
});

// --- decisions ---------------------------------------------------------------

describe('decide', () => {
  test('always returns a legal action: 2000+ seeded random decisions in full games', () => {
    const rng = E.makeRng(77);
    let decisions = 0;
    let joins = 0;
    let svaraOffers = 0;
    const counts = { fold: 0, check: 0, call: 0, raise: 0, allin: 0 };
    for (let table = 0; decisions < 2000; table++) {
      const stacks = Array.from({ length: 6 }, () => [8, 60, 200, 600, 1500][Math.floor(rng() * 5)]);
      const personas = stacks.map(() => NAMES[Math.floor(rng() * NAMES.length)]);
      const ante = [1, 5, 25][table % 3];
      const bb = ante * 2;
      const g = E.createGame({ players: mkPlayers(stacks), ante, bb, dealerIndex: table % 6, rng: E.makeRng(1000 + table) });
      for (let h = 0; h < 30; h++) {
        const st = g.getState();
        if (st.players.filter((p) => p.stack > 0).length < 2) break;
        h === 0 ? g.startHand() : g.nextHand();
        for (let steps = 0; g.getState().phase !== 'hand-over'; steps++) {
          assert.ok(steps < 300, 'hand must finish');
          const s = g.getState();
          if (s.phase === 'svara-offer') {
            svaraOffers++;
            const id = s.pendingSvaraDecisions[0];
            const seat = s.players.find((p) => p.id === id).seat;
            const join = AI.decideSvaraJoin(s, id, personas[seat], rng);
            assert.equal(typeof join, 'boolean');
            if (join) {
              joins++;
              const me = s.players.find((p) => p.id === id);
              assert.ok(s.svaraJoinCost <= 0.4 * me.stack, 'join cost ≤ 40% of the stack');
            }
            g.svaraJoin(id, join);
            continue;
          }
          const id = s.toAct;
          const seat = s.players.find((p) => p.id === id).seat;
          const L = g.legalActions(id);
          const action = AI.decide(s, id, personas[seat], rng);
          assertLegal(action, L, s.bb, `decision ${decisions}`);
          counts[action.type]++;
          g.act(id, action); // must not throw
          decisions++;
        }
      }
    }
    assert.ok(decisions >= 2000);
    for (const t of Object.keys(counts)) assert.ok(counts[t] > 0, `never chose ${t}: ${JSON.stringify(counts)}`);
    assert.ok(svaraOffers > 0);
  });

  test('always legal in odd spots reached by random play (incomplete raises, short stacks)', () => {
    const rng = E.makeRng(99);
    let checked = 0;
    for (let table = 0; checked < 1500; table++) {
      const stacks = Array.from({ length: 6 }, () => 1 + Math.floor(rng() * 400));
      const g = E.createGame({ players: mkPlayers(stacks), ante: 5, bb: 10, rng: E.makeRng(table) });
      for (let h = 0; h < 20; h++) {
        if (g.getState().players.filter((p) => p.stack > 0).length < 2) break;
        h === 0 ? g.startHand() : g.nextHand();
        while (g.getState().phase !== 'hand-over') {
          const s = g.getState();
          if (s.phase === 'svara-offer') { g.svaraJoin(s.pendingSvaraDecisions[0], rng() < 0.5); continue; }
          const L = g.legalActions(s.toAct);
          const persona = NAMES[Math.floor(rng() * NAMES.length)];
          const botAction = AI.decide(s, s.toAct, persona, rng);
          assertLegal(botAction, L, s.bb);
          checked++;
          // play a random legal action half of the time to reach unusual states
          let action = botAction;
          if (rng() < 0.5) {
            const opts = [];
            if (L.canCheck) opts.push({ type: 'check' });
            if (L.canCall) opts.push({ type: 'call' });
            if (L.canRaise) opts.push({ type: 'raise', amount: L.minRaiseTo + Math.floor(rng() * (L.maxRaiseTo - L.minRaiseTo + 1)) });
            if (L.canAllIn) opts.push({ type: 'allin' });
            if (L.canCall) opts.push({ type: 'fold' });
            action = opts[Math.floor(rng() * opts.length)];
          }
          g.act(s.toAct, action);
        }
      }
    }
  });

  test('uses only its own cards and public info', () => {
    const rng = E.makeRng(5);
    let compared = 0;
    for (let t = 0; t < 60; t++) {
      const g = E.createGame({ players: mkPlayers([1000, 1000, 1000, 1000, 1000, 1000]), ante: 5, bb: 10, rng: E.makeRng(t) });
      g.startHand();
      // a couple of actions so that there is something to call sometimes
      for (let i = 0; i < t % 4; i++) {
        const s = g.getState();
        g.act(s.toAct, i === 0 ? { type: 'raise', amount: 20 + 10 * (t % 5) } : { type: 'call' });
      }
      const s = g.getState();
      const bot = s.toAct;
      const persona = NAMES[t % NAMES.length];
      const a = AI.decide(s, bot, persona, E.makeRng(1234 + t));
      // shuffle everybody else's cards (and give them garbage) — the decision must not change
      const s2 = JSON.parse(JSON.stringify(s));
      const mine = new Set(s2.players.find((p) => p.id === bot).cards.map((c) => c.id));
      const pool = E.shuffle(E.newDeck().filter((c) => !mine.has(c.id)), rng);
      for (const p of s2.players) if (p.id !== bot) p.cards = pool.splice(0, 3);
      const b = AI.decide(s2, bot, persona, E.makeRng(1234 + t));
      assert.deepEqual(a, b);
      compared++;
    }
    assert.equal(compared, 60);
  });

  test('throws when it is not the bot\'s turn', () => {
    const g = E.createGame({ players: mkPlayers([1000, 1000, 1000]), ante: 5, bb: 10 });
    g.startHand();
    assert.throws(() => AI.decide(g.getState(), 'p2', 'tag', E.makeRng(1)), /not p2's turn/);
  });

  test('not trivially exploitable: mixes folds with calls/raises, bets with checks', () => {
    for (const persona of NAMES) {
      const facing = { fold: 0, play: 0 };
      const open = { check: 0, bet: 0 };
      for (let t = 0; t < 300; t++) {
        const rng = E.makeRng(t * 7 + 1);
        const g = E.createGame({ players: mkPlayers([1000, 1000, 1000, 1000]), ante: 5, bb: 10, rng });
        g.startHand();
        if (t % 2 === 0) {
          // p1 opens with a pot-sized bet; ask p2
          g.act('p1', { type: 'raise', amount: 20 });
          const s = g.getState();
          const a = AI.decide(s, 'p2', persona, rng);
          if (a.type === 'fold') facing.fold++; else facing.play++;
        } else {
          const a = AI.decide(g.getState(), 'p1', persona, rng);
          if (a.type === 'check') open.check++; else open.bet++;
        }
      }
      assert.ok(facing.fold > 5 && facing.play > 5, `${persona} facing a bet: ${JSON.stringify(facing)}`);
      assert.ok(open.check > 5 && open.bet > 5, `${persona} opening: ${JSON.stringify(open)}`);
    }
  });

  test('reads big bets as strength: folds 20 points to a 100 bb shove, re-raises less facing a 3-bet', () => {
    // Heads-up 5/10 with 1000 each: p0 acts first, p1–p4 fold, p5 is the bot under test.
    const spot = (hand, script) => {
      const rng = E.makeRng(1);
      const g = E.createGame({
        players: mkPlayers([1000, 1000, 1000, 1000, 1000, 1000]), ante: 5, bb: 10, dealerIndex: 5, rng,
        deckProvider: rigHands({ p5: hand, p0: '8s 8h 9d' }, rng),
      });
      g.startHand();
      for (const [id, a] of script) g.act(id, a);
      assert.equal(g.getState().toAct, 'p5');
      return g.getState();
    };
    const folds = ['p1', 'p2', 'p3', 'p4'].map((id) => [id, { type: 'fold' }]);
    const shove = [['p0', { type: 'allin' }], ...folds];
    const bet = [['p0', { type: 'raise', amount: 20 }], ...folds];
    const threeBet = [...bet, ['p5', { type: 'raise', amount: 60 }], ['p0', { type: 'raise', amount: 180 }]];
    const rng = E.makeRng(42);
    const rate = (s, persona, types, n = 150) => {
      let k = 0;
      for (let i = 0; i < n; i++) if (types.includes(AI.decide(s, 'p5', persona, rng).type)) k++;
      return k / n;
    };
    for (const persona of NAMES) {
      const fold = rate(spot('Kd Qd 9s', shove), persona, ['fold']);
      assert.ok(fold > 0.7, `${persona} folds 20 points to a 100 bb shove: ${fold}`);
      const call = rate(spot('10h 10d 10s', shove), persona, ['call', 'allin']);
      assert.ok(call > 0.9, `${persona} calls the shove with three tens: ${call}`);
    }
    let vsBet = 0;
    let vs3Bet = 0;
    for (const persona of NAMES) {
      for (const hand of ['Kd Qd 9s', 'Ah Kh 9s', 'As Ad 9h']) {
        vsBet += rate(spot(hand, bet), persona, ['raise', 'allin']);
        vs3Bet += rate(spot(hand, threeBet), persona, ['raise', 'allin']);
      }
    }
    assert.ok(vs3Bet < vsBet * 0.7, `re-raise rate facing a bet ${vsBet.toFixed(2)}, facing a 3-bet ${vs3Bet.toFixed(2)}`);
  });

  test('monsters are sometimes slow-played, weak hands are sometimes bluffed', () => {
    let slow = 0, fast = 0, bluffs = 0;
    for (let t = 0; t < 400; t++) {
      const rng = E.makeRng(500 + t);
      const hands = t % 2 === 0 ? { p1: '7s 7h 7d' } : { p1: '7h 8s 9d' };
      const g = E.createGame({ players: mkPlayers([1000, 1000, 1000]), ante: 5, bb: 10, rng, deckProvider: rigHands(hands, rng) });
      g.startHand();
      const a = AI.decide(g.getState(), 'p1', t % 4 < 2 ? 'tag' : 'maniac', rng);
      if (t % 2 === 0) { if (a.type === 'check') slow++; else fast++; }
      else if (a.type !== 'check') bluffs++;
    }
    assert.ok(slow > 5 && fast > 50, `slow ${slow} fast ${fast}`);
    assert.ok(bluffs > 3 && bluffs < 120, `bluffs ${bluffs}`);
  });

  test('strong hands put more chips in than weak ones', () => {
    const chipsIn = (hand) => {
      let total = 0;
      for (let t = 0; t < 200; t++) {
        const rng = E.makeRng(900 + t);
        const g = E.createGame({ players: mkPlayers([1000, 1000, 1000]), ante: 5, bb: 10, rng, deckProvider: rigHands({ p2: hand }, rng) });
        g.startHand();
        g.act('p1', { type: 'raise', amount: 10 }); // a min bet (bigger bets are read as strength)
        const a = AI.decide(g.getState(), 'p2', 'tag', rng);
        const L = g.legalActions('p2');
        total += a.type === 'fold' ? 0 : a.type === 'call' ? L.callAmount : a.type === 'allin' ? L.allInAmount : a.amount;
      }
      return total;
    };
    const trips = chipsIn('As Ah Ad');
    const medium = chipsIn('Kd Qd 10s');
    const weak = chipsIn('7h 8s 9d');
    assert.ok(trips > medium * 1.5 && medium > weak * 2, `${trips} ${medium} ${weak}`);
  });

  test('raise sizes are 2.5–3× the bet or 50–100% of the pot, in multiples of bb', () => {
    let raises = 0;
    for (let t = 0; t < 300; t++) {
      const rng = E.makeRng(3000 + t);
      const g = E.createGame({ players: mkPlayers([5000, 5000, 5000, 5000]), ante: 5, bb: 10, rng, deckProvider: rigHands({ p2: 'As Ah Ad' }, rng) });
      g.startHand();
      g.act('p1', { type: 'raise', amount: 40 });
      const s = g.getState(); // pot 60, current bet 40
      const a = AI.decide(s, 'p2', 'maniac', rng);
      if (a.type !== 'raise') continue;
      raises++;
      assert.equal(a.amount % 10, 0);
      assert.ok(a.amount >= 80 && a.amount <= 40 + 100, `raise to ${a.amount}`); // ≤ 3×40 or 40 + (pot + call)
    }
    assert.ok(raises > 50, `raises ${raises}`);
  });
});

// --- svara join --------------------------------------------------------------

describe('decideSvaraJoin', () => {
  function offer(stacks, deckHands) {
    const rng = E.makeRng(1);
    const g = E.createGame({ players: mkPlayers(stacks), ante: 5, bb: 10, rng, deckProvider: rigHands(deckHands, rng) });
    g.startHand();
    return g;
  }

  test('never joins when the cost is above 40% of the stack, or when not asked', () => {
    // p1 and p2 tie after betting 100 each → pot 215, cost 110; p0 has 245 → 110 > 98
    const g = offer([250, 1000, 1000], { p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' });
    g.act('p1', { type: 'raise', amount: 100 });
    g.act('p2', { type: 'call' });
    g.act('p0', { type: 'fold' });
    const s = g.getState();
    assert.equal(s.phase, 'svara-offer');
    assert.equal(s.svaraJoinCost, 110);
    for (let i = 0; i < 200; i++) assert.equal(AI.decideSvaraJoin(s, 'p0', 'maniac', E.makeRng(i)), false);
    assert.equal(AI.decideSvaraJoin(s, 'p1', 'maniac', E.makeRng(1)), false); // a participant, not pending
  });

  test('cheap svaras are joined sometimes, more by loose players than by rocks', () => {
    const g = offer([1000, 1000, 1000], { p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' });
    while (g.getState().phase === 'betting') g.act(g.getState().toAct, { type: 'check' });
    const s = g.getState();
    assert.equal(s.phase, 'svara-offer');
    assert.equal(s.svaraJoinCost, 10);
    const rate = (persona) => {
      let n = 0;
      for (let i = 0; i < 1000; i++) if (AI.decideSvaraJoin(s, 'p0', persona, E.makeRng(i))) n++;
      return n / 1000;
    };
    const rock = rate('rock');
    const maniac = rate('maniac');
    assert.ok(rock > 0 && rock < 0.5, `rock ${rock}`);
    assert.ok(maniac > rock, `maniac ${maniac} rock ${rock}`);
    assert.ok(maniac < 1);
  });
});
