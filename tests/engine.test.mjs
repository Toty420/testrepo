import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');

// --- helpers -----------------------------------------------------------------

const score = (ids, opts) => E.scoreHand(ids.split(' ').map(E.parseCard), opts);

function mkPlayers(stacks) {
  return stacks.map((stack, i) => ({ id: `p${i}`, name: `P${i}`, avatar: '🙂', stack, isHuman: i === 0 }));
}

/**
 * deckProvider that deals fixed hands. `deals` is a list (one entry per deal: the hand, then each
 * svara replay) of { playerId: 'Ah Kh Qh' }. Players without a fixed hand get unused cards.
 */
function rig(deals) {
  let n = 0;
  const provider = (info) => {
    const hands = deals[Math.min(n, deals.length - 1)];
    n++;
    provider.calls.push(info);
    const fixed = {};
    for (const [id, cards] of Object.entries(hands)) fixed[id] = cards.split(' ');
    const used = new Set(Object.values(fixed).flat());
    const rest = E.newDeck().map((c) => c.id).filter((id) => !used.has(id));
    const deck = [];
    for (const id of info.order) deck.push(...(fixed[id] || rest.splice(0, 3)));
    return deck.concat(rest);
  };
  provider.calls = [];
  return provider;
}

function game(stacks, opts = {}) {
  return E.createGame({ players: mkPlayers(stacks), ante: 5, bb: 10, dealerIndex: 0, rng: E.makeRng(1), ...opts });
}

const total = (s) => s.players.reduce((a, p) => a + p.stack, 0) + s.pot;
const stackOf = (g, id) => g.getState().players.find((p) => p.id === id).stack;
const types = (events) => events.map((e) => e.type);

/** Everyone still to act checks (or calls) until the betting round ends. */
function checkAround(g) {
  const events = [];
  let guard = 0;
  while (g.getState().phase === 'betting') {
    const s = g.getState();
    const L = g.legalActions(s.toAct);
    events.push(...g.act(s.toAct, { type: L.canCheck ? 'check' : 'call' }));
    if (++guard > 100) throw new Error('stuck');
  }
  return events;
}

// --- deck & cards ------------------------------------------------------------

describe('cards', () => {
  test('constants, deck, values, joker', () => {
    assert.deepEqual(E.RANKS, ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']);
    assert.deepEqual(E.SUITS, ['s', 'h', 'd', 'c']);
    const deck = E.newDeck();
    assert.equal(deck.length, 32);
    assert.equal(new Set(deck.map((c) => c.id)).size, 32);
    assert.deepEqual(deck.find((c) => c.rank === '10' && c.suit === 'h'), { rank: '10', suit: 'h', id: '10h' });
    const v = (id) => E.cardValue(E.parseCard(id));
    assert.deepEqual(['7s', '8s', '9s', '10s', 'Js', 'Qs', 'Ks', 'As'].map(v), [7, 8, 9, 10, 10, 10, 10, 11]);
    assert.equal(E.isJoker(E.parseCard('7c')), true);
    assert.equal(E.isJoker(E.parseCard('7c'), false), false);
    assert.equal(E.isJoker(E.parseCard('7h')), false);
    assert.throws(() => E.parseCard('1x'), /Invalid card/);
  });

  test('shuffle is a permutation and makeRng is deterministic', () => {
    const a = E.shuffle(E.newDeck(), E.makeRng(42)).map((c) => c.id);
    const b = E.shuffle(E.newDeck(), E.makeRng(42)).map((c) => c.id);
    const c = E.shuffle(E.newDeck(), E.makeRng(43)).map((c) => c.id);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.deepEqual([...a].sort(), E.newDeck().map((x) => x.id).sort());
    const r = E.makeRng(7);
    for (let i = 0; i < 1000; i++) { const x = r(); assert.ok(x >= 0 && x < 1); }
  });
});

// --- scoring -----------------------------------------------------------------

describe('scoreHand', () => {
  const cases = [
    // [cards, points, kind, label]
    // SPEC examples
    ['Ah Kh Qh', 31, 'suit', '31 точки'],
    ['Ah Kh 7c', 32, 'suit', '32 точки'],
    ['Kd Qd 10s', 20, 'suit', '20 точки'],
    ['9h 8s 7c', 20, 'suit', '20 точки'],
    ['8s 9h 10d', 10, 'suit', '10 точки'],
    ['Ah As 7c', 33, 'trips', 'Три аса'],
    ['9h 9d 7c', 27, 'trips', 'Три деветки'],
    // three 7s
    ['7s 7h 7d', 34, 'three7', 'Три седмици'],
    ['7c 7h 7d', 34, 'three7', 'Три седмици'],
    ['7s 7c 7d', 34, 'three7', 'Три седмици'],
    // natural trips
    ['As Ah Ad', 33, 'trips', 'Три аса'],
    ['Ks Kh Kd', 30, 'trips', 'Три попа'],
    ['Qs Qh Qc', 30, 'trips', 'Три дами'],
    ['Js Jh Jd', 30, 'trips', 'Три валета'],
    ['10s 10h 10d', 30, 'trips', 'Три десетки'],
    ['9s 9h 9c', 27, 'trips', 'Три деветки'],
    ['8s 8h 8d', 24, 'trips', 'Три осмици'],
    // joker + a pair completes the trips (every rank)
    ['Kh Kd 7c', 30, 'trips', 'Три попа'],
    ['Qh Qs 7c', 30, 'trips', 'Три дами'],
    ['Jh Jd 7c', 30, 'trips', 'Три валета'],
    ['10h 10d 7c', 30, 'trips', 'Три десетки'],
    ['8h 8d 7c', 24, 'trips', 'Три осмици'],
    // joker joins any suit (counts 11)
    ['Kh Qh 7c', 31, 'suit', '31 точки'],
    ['8h 9h 7c', 28, 'suit', '28 точки'],
    ['10s Jd 7c', 21, 'suit', '21 точки'],
    ['8s 9h 7c', 20, 'suit', '20 точки'],
    ['Ac Kc 7c', 32, 'suit', '32 точки'],
    ['8c 9c 7c', 28, 'suit', '28 точки'],
    ['Ah 7c 9s', 22, 'suit', '22 точки'], // the joker is not an ace, but A + joker = 22 points anyway
    // two aces
    ['Ah As Kd', 22, 'aces', 'Два аса'],
    ['Ah As Kh', 22, 'aces', 'Два аса'], // hearts would be 21
    ['Ah Ad 9h', 22, 'aces', 'Два аса'], // hearts 20
    // plain suit sums
    ['Ah Kh 9s', 21, 'suit', '21 точки'],
    ['As Ks Qd', 21, 'suit', '21 точки'],
    ['7h 8s 9d', 9, 'suit', '9 точки'],
    ['7s 8s 9s', 24, 'suit', '24 точки'],
    ['Js Qs Ks', 30, 'suit', '30 точки'],
  ];
  for (const [cards, points, kind, label] of cases) {
    test(`${cards} = ${points} (${kind})`, () => {
      const s = score(cards);
      assert.equal(s.points, points);
      assert.equal(s.kind, kind);
      assert.equal(s.label, label);
    });
  }

  test('jokerWild: false makes 7♣ an ordinary 7 of clubs', () => {
    const plain = { jokerWild: false };
    assert.equal(score('Ah Kh 7c', plain).points, 21);
    assert.equal(score('Ah As 7c', plain).points, 22);
    assert.equal(score('Ah As 7c', plain).kind, 'aces');
    assert.equal(score('9h 9d 7c', plain).points, 9);
    assert.equal(score('8c 9c 7c', plain).points, 24);
    assert.equal(score('9h 8s 7c', plain).points, 9);
    assert.equal(score('7c 7h 7d', plain).points, 34); // still three 7s
    assert.equal(score('7c 8c 9c').points, 28); // wild by default
  });

  test('usedCardIds marks the cards that count', () => {
    assert.deepEqual(score('Kd Qd 10s').usedCardIds, ['Kd', 'Qd']);
    assert.deepEqual(score('9h 8s 7c').usedCardIds, ['9h', '7c']);
    assert.deepEqual(score('8s 9h 10d').usedCardIds, ['10d']);
    assert.deepEqual(score('Ah As Kd').usedCardIds, ['Ah', 'As']);
    assert.deepEqual(score('Ah As 7c').usedCardIds, ['Ah', 'As', '7c']);
    assert.deepEqual(score('7s 7h 7d').usedCardIds, ['7s', '7h', '7d']);
    assert.deepEqual(score('Ah Kh 7c').usedCardIds, ['Ah', 'Kh', '7c']);
  });

  test('accepts card ids too, rejects bad input', () => {
    assert.equal(E.scoreHand(['Ah', 'Kh', 'Qh']).points, 31);
    assert.throws(() => E.scoreHand([]), /1 to 3 cards/);
    assert.throws(() => E.scoreHand(['Ah', 'Ah', 'Kh']), /duplicate/);
  });

  test('exhaustive: the joker scores like the best natural card it could stand for', () => {
    // Cross-check every 3-card hand: with the joker, points = max over substituting 7♣ by any card
    // (scored without a joker). Also sanity bounds for all 4960 hands.
    const deck = E.newDeck();
    let count = 0;
    for (let i = 0; i < 32; i++) for (let j = i + 1; j < 32; j++) for (let k = j + 1; k < 32; k++) {
      const hand = [deck[i], deck[j], deck[k]];
      const s = E.scoreHand(hand);
      count++;
      assert.ok(s.points >= 7 && s.points <= 34);
      const maxCard = Math.max(...hand.map((c) => (E.isJoker(c) ? 11 : E.cardValue(c))));
      assert.ok(s.points >= maxCard, `${hand.map((c) => c.id)} below its highest card`);
      assert.ok(s.usedCardIds.length >= 1 && s.usedCardIds.every((id) => hand.some((c) => c.id === id)));
      const jk = hand.findIndex((c) => E.isJoker(c));
      if (jk >= 0) {
        let best = 0;
        for (const sub of deck) {
          const h2 = hand.slice();
          h2[jk] = sub;
          // allow duplicates by scoring card objects directly via the plain scorer
          const pts = plainPoints(h2);
          if (pts > best) best = pts;
        }
        assert.equal(s.points, best, `joker hand ${hand.map((c) => c.id)}`);
      } else {
        assert.equal(s.points, plainPoints(hand));
      }
    }
    assert.equal(count, 4960);
  });

  test('compareScores: more points first, equal points = tie', () => {
    const a = score('Ah Kh Qh');
    const b = score('Ac Kc Qc');
    const c = score('Ks Kh Kd');
    assert.equal(E.compareScores(a, b), 0); // no kickers
    assert.ok(E.compareScores(a, c) < 0);
    assert.ok(E.compareScores(c, a) > 0);
    assert.equal(E.compareScores(score('Ks Kh Kd'), score('10s 10h 10d')), 0);
    assert.equal(E.compareScores(score('Ah As Kd'), score('Ah 7c 9s')), 0); // 22 vs 22
    const sorted = [c, a, score('8s 9h 10d')].sort(E.compareScores).map((s) => s.points);
    assert.deepEqual(sorted, [31, 30, 10]);
  });
});

/** Independent reference scorer without joker rules (duplicates allowed). */
function plainPoints(hand) {
  const val = { 7: 7, 8: 8, 9: 9, 10: 10, J: 10, Q: 10, K: 10, A: 11 };
  const ranks = hand.map((c) => c.rank);
  let best = 0;
  if (ranks.every((r) => r === '7')) best = 34;
  else if (ranks.every((r) => r === ranks[0])) best = val[ranks[0]] * 3;
  if (ranks.filter((r) => r === 'A').length >= 2) best = Math.max(best, 22);
  for (const s of ['s', 'h', 'd', 'c']) {
    best = Math.max(best, hand.filter((c) => c.suit === s).reduce((a, c) => a + val[c.rank], 0));
  }
  return best;
}

// --- game setup & state ------------------------------------------------------

describe('game basics', () => {
  test('startHand posts antes, deals 3 cards, first to act is left of the dealer', () => {
    const g = game([1000, 1000, 1000, 1000, 1000, 1000], { dealerIndex: 2 });
    let s = g.getState();
    assert.equal(s.phase, 'idle');
    const ev = g.startHand();
    s = g.getState();
    assert.equal(s.phase, 'betting');
    assert.equal(s.handNumber, 1);
    assert.equal(s.dealerIndex, 2);
    assert.equal(s.pot, 30);
    assert.equal(s.currentBet, 0);
    assert.equal(s.minRaiseTo, 10);
    assert.equal(s.toAct, 'p3');
    assert.deepEqual(s.pots, [{ amount: 30, eligible: ['p3', 'p4', 'p5', 'p0', 'p1', 'p2'] }]);
    for (const p of s.players) {
      assert.equal(p.stack, 995);
      assert.equal(p.committed, 5);
      assert.equal(p.roundBet, 0);
      assert.equal(p.cards.length, 3);
      assert.equal(p.inHand, true);
    }
    const all = s.players.flatMap((p) => p.cards.map((c) => c.id));
    assert.equal(new Set(all).size, 18);
    assert.deepEqual(ev[0], { type: 'hand-start', handNumber: 1, dealerIndex: 2 });
    assert.deepEqual(types(ev), ['hand-start', ...Array(6).fill('ante'), ...Array(6).fill('deal'), 'turn']);
    assert.equal(ev[1].playerId, 'p3'); // antes and deal go left of the dealer
    assert.deepEqual(ev.filter((e) => e.type === 'deal').map((e) => e.playerId), ['p3', 'p4', 'p5', 'p0', 'p1', 'p2']);
    assert.ok(ev.filter((e) => e.type === 'deal').every((e) => e.count === 3));
    assert.deepEqual(ev[ev.length - 1], { type: 'turn', playerId: 'p3' });
  });

  test('betting order goes clockwise, wraps and skips players with no chips', () => {
    const g = game([1000, 1000, 1000, 1000, 0, 1000], { dealerIndex: 2 });
    g.startHand();
    const s = g.getState();
    assert.equal(s.players[4].sittingOut, true);
    assert.equal(s.players[4].inHand, false);
    assert.equal(s.players[4].cards.length, 0);
    assert.equal(s.pot, 25);
    const order = [];
    while (g.getState().phase === 'betting') {
      const id = g.getState().toAct;
      order.push(id);
      g.act(id, { type: 'check' });
    }
    assert.deepEqual(order, ['p3', 'p5', 'p0', 'p1', 'p2']);
  });

  test('after a bet, action continues around to everyone who has not matched it', () => {
    const g = game([1000, 1000, 1000, 1000]);
    g.startHand(); // dealer p0 → p1 first
    g.act('p1', { type: 'check' });
    g.act('p2', { type: 'raise', amount: 20 });
    const order = [];
    while (g.getState().phase === 'betting') {
      const id = g.getState().toAct;
      order.push(id);
      g.act(id, { type: 'call' });
    }
    assert.deepEqual(order, ['p3', 'p0', 'p1']);
  });

  test('getState returns a deep copy', () => {
    const g = game([1000, 1000, 1000]);
    g.startHand();
    const s = g.getState();
    s.players[0].stack = -1;
    s.players[0].cards[0].rank = 'X';
    s.pots[0].eligible.push('zzz');
    s.svaraParticipants.push('q');
    const t = g.getState();
    assert.equal(t.players[0].stack, 995);
    assert.notEqual(t.players[0].cards[0].rank, 'X');
    assert.deepEqual(t.pots[0].eligible.length, 3);
    assert.deepEqual(t.svaraParticipants, []);
  });

  test('createGame validates its config', () => {
    assert.throws(() => E.createGame({ players: mkPlayers([100]), ante: 5, bb: 10 }), /at least 2/);
    assert.throws(() => E.createGame({ players: mkPlayers([100, 100]), ante: 0, bb: 10 }), /ante/);
    assert.throws(() => E.createGame({ players: mkPlayers([100, 100]), ante: 5, bb: 2.5 }), /bb/);
    assert.throws(() => E.createGame({ players: [{ id: 'a', stack: 1 }, { id: 'a', stack: 1 }], ante: 5, bb: 10 }), /already seated/);
    assert.throws(() => E.createGame({ players: mkPlayers([100, 100]), ante: 5, bb: 10, dealerIndex: 2 }), /dealerIndex/);
  });

  test('startHand needs two players with chips', () => {
    const g = game([1000, 0, 0]);
    assert.throws(() => g.startHand(), /at least 2 players/);
  });
});

// --- legal actions & illegal actions -----------------------------------------

describe('betting rules', () => {
  test('legalActions: opening bet, call amounts, flags off when not your turn', () => {
    const g = game([1000, 1000, 1000]);
    g.startHand();
    let L = g.legalActions('p1');
    assert.equal(L.isTurn, true);
    assert.equal(L.canFold, true);
    assert.equal(L.canCheck, true);
    assert.equal(L.canCall, false);
    assert.equal(L.callAmount, 0);
    assert.equal(L.canRaise, true);
    assert.equal(L.isBet, true);
    assert.equal(L.minRaiseTo, 10);
    assert.equal(L.maxRaiseTo, 995);
    assert.equal(L.canAllIn, true);
    assert.equal(L.allInAmount, 995);
    const other = g.legalActions('p2');
    assert.equal(other.isTurn, false);
    assert.equal(other.canFold || other.canCheck || other.canCall || other.canRaise || other.canAllIn, false);
    g.act('p1', { type: 'raise', amount: 40 });
    L = g.legalActions('p2');
    assert.equal(L.canCheck, false);
    assert.equal(L.canCall, true);
    assert.equal(L.callAmount, 40);
    assert.equal(L.isBet, false);
    assert.equal(L.minRaiseTo, 80);
  });

  test('min-raise: first bet ≥ bb, raise-to ≥ currentBet + last full raise', () => {
    const g = game([1000, 1000, 1000, 1000]);
    g.startHand();
    assert.throws(() => g.act('p1', { type: 'raise', amount: 5 }), /below the minimum 10/);
    g.act('p1', { type: 'raise', amount: 10 });
    let s = g.getState();
    assert.equal(s.currentBet, 10);
    assert.equal(s.minRaiseTo, 20);
    assert.throws(() => g.act('p2', { type: 'raise', amount: 15 }), /below the minimum 20/);
    g.act('p2', { type: 'raise', amount: 40 }); // +30
    s = g.getState();
    assert.equal(s.minRaiseTo, 70);
    assert.throws(() => g.act('p3', { type: 'raise', amount: 60 }), /minimum 70/);
    g.act('p3', { type: 'raise', amount: 70 }); // +30
    assert.equal(g.getState().minRaiseTo, 100);
    g.act('p0', { type: 'raise', amount: 200 }); // +130
    s = g.getState();
    assert.equal(s.minRaiseTo, 330);
    assert.equal(s.currentBet, 200);
    assert.equal(s.players[0].roundBet, 200);
    assert.equal(s.players[0].committed, 205);
    assert.equal(s.pot, 20 + 10 + 40 + 70 + 200);
  });

  test('illegal actions throw clear errors', () => {
    const g = game([1000, 1000, 1000]);
    assert.throws(() => g.act('p1', { type: 'check' }), /phase 'idle'/);
    assert.throws(() => g.svaraJoin('p1', true), /svara offer/);
    g.startHand();
    assert.throws(() => g.startHand(), /between hands/);
    assert.throws(() => g.nextHand(), /not over/);
    assert.throws(() => g.act('p2', { type: 'check' }), /not P2's turn/);
    assert.throws(() => g.act('nobody', { type: 'check' }), /Unknown player/);
    assert.throws(() => g.act('p1', { type: 'call' }), /nothing to call/);
    assert.throws(() => g.act('p1', { type: 'raise' }), /integer amount/);
    assert.throws(() => g.act('p1', { type: 'raise', amount: 5000 }), /more than the stack/);
    assert.throws(() => g.act('p1', { type: 'dance' }), /unknown action/);
    assert.throws(() => g.act('p1'), /action must be/);
    g.act('p1', { type: 'raise', amount: 20 });
    assert.throws(() => g.act('p2', { type: 'check' }), /cannot check, 20 to call/);
    assert.throws(() => g.setPlayer(1, null), /between hands/);
    assert.throws(() => g.addChips('p1', 100), /between hands/);
  });

  test('a raise of the whole stack below the min raise is accepted as an all-in', () => {
    const g = game([1000, 1000, 40]);
    g.startHand();
    g.act('p1', { type: 'raise', amount: 30 }); // min next raise-to: 60
    let L = g.legalActions('p2');
    assert.equal(L.canRaise, false); // can't afford a full raise (max 35)
    assert.equal(L.canAllIn, true);
    assert.equal(L.maxRaiseTo, 35);
    assert.throws(() => g.act('p2', { type: 'raise', amount: 34 }), /not enough chips for a full raise/);
    const ev = g.act('p2', { type: 'raise', amount: 35 });
    assert.equal(ev[0].action.type, 'allin');
    assert.equal(ev[0].action.amount, 35);
    assert.equal(ev[0].stack, 0);
    assert.equal(g.getState().players[2].allIn, true);
  });

  test('incomplete all-in raise does not reopen the betting for players who already acted', () => {
    const g = game([1000, 1000, 155]); // p2 has 150 after the ante
    g.startHand();
    g.act('p1', { type: 'raise', amount: 100 });
    const ev = g.act('p2', { type: 'allin' }); // to 150: +50, less than the full raise of 100
    assert.equal(ev[0].action.type, 'allin');
    assert.equal(ev[0].action.amount, 150);
    let s = g.getState();
    assert.equal(s.currentBet, 150);
    assert.equal(s.minRaiseTo, 250); // the full raise size stays 100
    // p0 has not acted yet: may raise
    let L = g.legalActions('p0');
    assert.equal(L.canRaise, true);
    assert.equal(L.minRaiseTo, 250);
    g.act('p0', { type: 'call' });
    // p1 already acted at 100 and only faces +50: call or fold only
    L = g.legalActions('p1');
    assert.equal(L.isTurn, true);
    assert.equal(L.canCall, true);
    assert.equal(L.callAmount, 50);
    assert.equal(L.canRaise, false);
    assert.equal(L.canAllIn, false);
    assert.throws(() => g.act('p1', { type: 'raise', amount: 300 }), /not allowed/);
    assert.throws(() => g.act('p1', { type: 'allin' }), /not allowed/);
    const end = g.act('p1', { type: 'call' });
    assert.ok(types(end).includes('round-end'));
    assert.ok(types(end).includes('showdown'));
    s = g.getState();
    assert.ok(s.phase === 'hand-over' || s.phase === 'svara-offer');
  });

  test('a full raise after an incomplete all-in reopens the betting', () => {
    const g = game([1000, 1000, 155, 1000]);
    g.startHand();
    g.act('p1', { type: 'raise', amount: 100 });
    g.act('p2', { type: 'allin' }); // 150, incomplete
    g.act('p3', { type: 'raise', amount: 300 }); // +150 ≥ 100: full raise
    assert.equal(g.getState().minRaiseTo, 450);
    g.act('p0', { type: 'fold' });
    const L = g.legalActions('p1');
    assert.equal(L.canRaise, true);
    assert.equal(L.minRaiseTo, 450);
  });

  test('incomplete all-ins that add up to a full raise reopen the betting (standard rule)', () => {
    const g = game([1000, 1000, 155, 215]);
    g.startHand();
    g.act('p1', { type: 'raise', amount: 100 });
    g.act('p2', { type: 'allin' }); // 150 (+50)
    g.act('p3', { type: 'allin' }); // 210 (+60) — still incomplete on its own
    const s = g.getState();
    assert.equal(s.currentBet, 210);
    assert.equal(s.minRaiseTo, 310);
    g.act('p0', { type: 'call' });
    const L = g.legalActions('p1'); // faces 110 more than when it acted ≥ 100
    assert.equal(L.canRaise, true);
  });

  test('an opening all-in below bb: next raise-to is at least currentBet + bb, checkers can only call', () => {
    const g = game([1000, 1000, 11]); // p2: 6 after the ante
    g.startHand();
    g.act('p1', { type: 'check' });
    g.act('p2', { type: 'allin' });
    const s = g.getState();
    assert.equal(s.currentBet, 6);
    assert.equal(s.minRaiseTo, 16);
    assert.equal(g.legalActions('p0').canRaise, true);
    g.act('p0', { type: 'call' });
    const L = g.legalActions('p1');
    assert.equal(L.canRaise, false);
    assert.equal(L.callAmount, 6);
  });

  test('call for less than the full amount puts the player all-in', () => {
    const g = game([1000, 1000, 105]);
    g.startHand();
    g.act('p1', { type: 'raise', amount: 300 });
    const L = g.legalActions('p2');
    assert.equal(L.callAmount, 100);
    assert.equal(L.callIsAllIn, true);
    assert.equal(L.canRaise, false);
    assert.equal(L.canAllIn, true);
    const ev = g.act('p2', { type: 'call' });
    assert.equal(ev[0].action.type, 'allin');
    assert.equal(ev[0].action.added, 100);
    assert.equal(g.getState().players[2].allIn, true);
  });

  test('the last player who can act cannot raise when everyone else is all-in', () => {
    const g = game([1000, 205, 1000]);
    g.startHand();
    g.act('p1', { type: 'allin' }); // 200
    g.act('p2', { type: 'fold' });
    const L = g.legalActions('p0');
    assert.equal(L.canCall, true);
    assert.equal(L.callAmount, 200);
    assert.equal(L.canRaise, false);
    assert.equal(L.canAllIn, false);
  });

  test('lastAction and action events', () => {
    const g = game([1000, 1000, 1000]);
    g.startHand();
    let ev = g.act('p1', { type: 'raise', amount: 20 });
    assert.deepEqual(ev[0], {
      type: 'action', playerId: 'p1', action: { type: 'raise', amount: 20, added: 20, isBet: true }, stack: 975, roundBet: 20,
    });
    assert.deepEqual(ev[1], { type: 'turn', playerId: 'p2' });
    ev = g.act('p2', { type: 'call' });
    assert.deepEqual(ev[0].action, { type: 'call', amount: 20, added: 20, isBet: false });
    ev = g.act('p0', { type: 'raise', amount: 60 });
    assert.deepEqual(ev[0].action, { type: 'raise', amount: 60, added: 60, isBet: false });
    ev = g.act('p1', { type: 'fold' });
    assert.deepEqual(ev[0].action, { type: 'fold', amount: 0, added: 0, isBet: false });
    const s = g.getState();
    assert.deepEqual(s.players[1].lastAction, { type: 'fold', amount: 0, added: 0, isBet: false });
    assert.equal(s.players[1].folded, true);
    assert.equal(s.toAct, 'p2');
  });
});

// --- antes ------------------------------------------------------------------

describe('antes', () => {
  test('a player with less than the ante goes all-in for it and is skipped in the betting', () => {
    const g = game([1000, 3, 1000]);
    const ev = g.startHand();
    const s = g.getState();
    assert.equal(s.pot, 13);
    const p1 = s.players[1];
    assert.equal(p1.stack, 0);
    assert.equal(p1.committed, 3);
    assert.equal(p1.allIn, true);
    assert.deepEqual(ev.find((e) => e.type === 'ante' && e.playerId === 'p1'), { type: 'ante', playerId: 'p1', amount: 3, allIn: true });
    assert.equal(s.toAct, 'p2');
    assert.deepEqual(s.pots, [{ amount: 9, eligible: ['p1', 'p2', 'p0'] }, { amount: 4, eligible: ['p2', 'p0'] }]);
  });

  test('if nobody can bet after the antes, it goes straight to showdown', () => {
    const deck = rig([{ p0: 'Ah Kh Qh', p1: '8s 9h 10d' }]);
    const g = game([1000, 4], { deckProvider: deck });
    const ev = g.startHand();
    assert.deepEqual(types(ev).slice(-4), ['showdown', 'win', 'win', 'hand-over']);
    const s = g.getState();
    assert.equal(s.phase, 'hand-over');
    // main pot 8 to p0, p0's 1 extra ante chip back to p0
    assert.equal(s.players[0].stack, 1004);
    assert.equal(s.players[1].stack, 0);
    assert.equal(s.players[1].sittingOut, true);
  });
});

// --- pots ------------------------------------------------------------------

describe('pots & payouts', () => {
  test('uncontested win: everyone folds, no showdown, no cards shown', () => {
    const g = game([1000, 1000, 1000, 1000, 1000, 1000]);
    g.startHand();
    g.act('p1', { type: 'raise', amount: 50 });
    let ev = [];
    for (const id of ['p2', 'p3', 'p4', 'p5']) ev = g.act(id, { type: 'fold' });
    ev = g.act('p0', { type: 'fold' });
    assert.deepEqual(types(ev), ['action', 'round-end', 'win', 'hand-over']);
    assert.deepEqual(ev[1], { type: 'round-end', pot: 80 });
    assert.deepEqual(ev[2], { type: 'win', playerId: 'p1', amount: 80, potIndex: 0, uncontested: true });
    const s = g.getState();
    assert.equal(s.phase, 'hand-over');
    assert.equal(s.pot, 0);
    assert.equal(s.toAct, null);
    assert.equal(s.players[1].stack, 1025);
    assert.deepEqual(s.lastResult, { winners: [{ playerId: 'p1', amount: 80, potIndex: 0 }], svara: false, scores: {}, uncontested: true });
    assert.ok(s.players.every((p) => p.score === null));
    assert.ok(s.players.every((p) => p.roundBet === 0));
    assert.equal(total(s), 6000);
  });

  test('showdown: best hand wins the pot', () => {
    const deck = rig([{ p0: 'Ah Kh Qh', p1: 'Ks Kc Kd', p2: '8s 9h 10d' }]);
    const g = game([1000, 1000, 1000], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'raise', amount: 100 });
    g.act('p2', { type: 'call' });
    const ev = g.act('p0', { type: 'call' });
    assert.deepEqual(types(ev), ['action', 'round-end', 'showdown', 'win', 'hand-over']);
    const sd = ev.find((e) => e.type === 'showdown');
    assert.equal(sd.scores.p0.points, 31);
    assert.equal(sd.scores.p1.label, 'Три попа');
    assert.deepEqual(sd.cards.p2.map((c) => c.id), ['8s', '9h', '10d']);
    const s = g.getState();
    assert.equal(s.players[0].stack, 1000 - 105 + 315);
    assert.equal(s.lastResult.uncontested, false);
    assert.equal(s.lastResult.svara, false);
    assert.deepEqual(s.lastResult.winners, [{ playerId: 'p0', amount: 315, potIndex: 0 }]);
    assert.equal(s.players[1].score.points, 30);
  });

  test('side pots with three all-ins of different sizes', () => {
    const deck = rig([{ p1: '7s 7h 7d', p2: 'As Ah Ad', p3: 'Ks Kh Kd', p0: '8s 9h 10d' }]);
    const g = game([1000, 105, 305, 605], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'allin' }); // 100
    g.act('p2', { type: 'allin' }); // 300
    g.act('p3', { type: 'allin' }); // 600
    let s = g.getState();
    // p0 has not called yet: still eligible for every pot
    assert.deepEqual(s.pots, [
      { amount: 105 * 3 + 5, eligible: ['p1', 'p2', 'p3', 'p0'] },
      { amount: 400, eligible: ['p2', 'p3', 'p0'] },
      { amount: 300, eligible: ['p3', 'p0'] },
    ]);
    const L = g.legalActions('p0');
    assert.equal(L.callAmount, 600);
    assert.equal(L.canRaise, false);
    const ev = g.act('p0', { type: 'call' });
    s = g.getState();
    assert.deepEqual(s.pots, []);
    assert.deepEqual(ev.filter((e) => e.type === 'win').map((e) => [e.playerId, e.amount, e.potIndex]), [
      ['p1', 420, 0], ['p2', 600, 1], ['p3', 600, 2],
    ]);
    assert.deepEqual(s.players.map((p) => p.stack), [395, 420, 600, 600]);
    assert.equal(total(s), 2015);
  });

  test('side pots: a short stack can win the main pot while a bigger stack wins the side pot', () => {
    const deck = rig([{ p1: 'Ah Kh Qh', p2: 'Ks Qs 9d', p0: '8s 9h 10d' }]);
    const g = game([1000, 105, 1000], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'allin' }); // 100
    g.act('p2', { type: 'raise', amount: 300 });
    g.act('p0', { type: 'call' });
    const s = g.getState();
    assert.deepEqual(s.lastResult.winners, [{ playerId: 'p1', amount: 315, potIndex: 0 }, { playerId: 'p2', amount: 400, potIndex: 1 }]);
    assert.deepEqual(s.players.map((p) => p.stack), [695, 315, 1095]);
  });

  test('a folded player\'s chips stay in the pots as dead money', () => {
    const deck = rig([{ p1: 'Ah Kh Qh', p2: 'Ks Qs 9d', p0: '8s 9h 10d', p3: '8h 9c Jc' }]);
    const g = game([1000, 55, 1000, 1000], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'allin' }); // 50
    g.act('p2', { type: 'raise', amount: 200 });
    g.act('p3', { type: 'call' });
    g.act('p0', { type: 'raise', amount: 600 });
    g.act('p2', { type: 'fold' }); // p2's 205 stays in the middle
    const ev = g.act('p3', { type: 'call' });
    assert.ok(types(ev).includes('showdown'));
    assert.deepEqual(Object.keys(ev.find((e) => e.type === 'showdown').scores).sort(), ['p0', 'p1', 'p3']);
    const s = g.getState();
    // main: 55×4 = 220 → p1; side: 150 (p2, folded) + 550 (p3) + 550 (p0) = 1250 → p3
    assert.deepEqual(s.lastResult.winners, [{ playerId: 'p1', amount: 220, potIndex: 0 }, { playerId: 'p3', amount: 1250, potIndex: 1 }]);
    assert.deepEqual(s.players.map((p) => p.stack), [395, 220, 795, 1645]);
    assert.equal(total(s), 3055);
  });

  test('odd chips go to the winners in seat order starting left of the dealer (split when svara is off)', () => {
    for (const [dealerIndex, expected] of [[0, { p1: 8, p2: 7 }], [1, { p1: 7, p2: 8 }], [2, { p1: 8, p2: 7 }]]) {
      const deck = rig([{ p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' }]);
      const g = game([1000, 1000, 1000], { deckProvider: deck, maxSvaras: 0, dealerIndex });
      g.startHand();
      const ev = checkAround(g);
      const wins = Object.fromEntries(ev.filter((e) => e.type === 'win').map((e) => [e.playerId, e.amount]));
      assert.deepEqual(wins, expected, `dealer ${dealerIndex}`);
      assert.equal(g.getState().phase, 'hand-over');
    }
  });
});

// --- svara -----------------------------------------------------------------

describe('svara', () => {
  test('a tie on the main pot triggers a svara offer', () => {
    const deck = rig([{ p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' }]);
    const g = game([1000, 1000, 1000], { deckProvider: deck });
    g.startHand();
    const ev = checkAround(g);
    assert.deepEqual(types(ev).slice(-4), ['action', 'round-end', 'showdown', 'svara']);
    assert.deepEqual(ev[ev.length - 1], { type: 'svara', participants: ['p1', 'p2'], svaraPot: 15, joinCost: 10, pending: ['p0'] });
    const s = g.getState();
    assert.equal(s.phase, 'svara-offer');
    assert.equal(s.toAct, null);
    assert.equal(s.svaraPot, 15);
    assert.equal(s.pot, 15);
    assert.deepEqual(s.pots, [{ amount: 15, eligible: ['p1', 'p2'] }]);
    assert.deepEqual(s.svaraParticipants, ['p1', 'p2']);
    assert.equal(s.svaraJoinCost, 10); // ceil(15/2) = 8 → rounded up to the ante: 10
    assert.deepEqual(s.pendingSvaraDecisions, ['p0']);
    assert.deepEqual(s.lastResult, { winners: [], svara: true, scores: s.lastResult.scores, uncontested: false });
    assert.equal(Object.keys(s.lastResult.scores).length, 3);
    assert.throws(() => g.act('p1', { type: 'check' }), /phase 'svara-offer'/);
    assert.throws(() => g.svaraJoin('p1', true), /no pending svara decision/);
    assert.throws(() => g.nextHand(), /not over/);
  });

  test('join: pay the cost, then a svara replay with a fresh deal, no ante, same button', () => {
    const deck = rig([
      { p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' },
      { p0: 'Ks Kh Kd', p1: '8s 9h 10d', p2: '8h 9d Jc' },
    ]);
    const g = game([1000, 1000, 1000], { deckProvider: deck });
    g.startHand();
    checkAround(g);
    const ev = g.svaraJoin('p0', true);
    assert.deepEqual(types(ev), ['svara-join', 'svara-start', 'deal', 'deal', 'deal', 'turn']);
    assert.deepEqual(ev[0], { type: 'svara-join', playerId: 'p0', paid: 10 });
    assert.deepEqual(ev[1], { type: 'svara-start', participants: ['p1', 'p2', 'p0'], pot: 25 });
    assert.deepEqual(ev[5], { type: 'turn', playerId: 'p1' });
    let s = g.getState();
    assert.equal(s.phase, 'betting');
    assert.equal(s.isSvara, true);
    assert.equal(s.svaraCount, 1);
    assert.equal(s.dealerIndex, 0);
    assert.equal(s.handNumber, 1);
    assert.equal(s.pot, 25);
    assert.equal(s.svaraPot, 25);
    assert.deepEqual(s.pots, [{ amount: 25, eligible: ['p1', 'p2', 'p0'] }]);
    assert.deepEqual(s.players.map((p) => p.stack), [985, 995, 995]);
    assert.ok(s.players.every((p) => p.committed === 0 && p.inHand && p.cards.length === 3 && p.lastAction === null));
    assert.deepEqual(s.players[0].cards.map((c) => c.id), ['Ks', 'Kh', 'Kd']);
    assert.equal(deck.calls[1].isSvara, true);
    assert.equal(total(s), 3000);
    // Replay: p1 bets, everyone calls; p0 wins with three kings
    g.act('p1', { type: 'raise', amount: 20 });
    g.act('p2', { type: 'call' });
    const end = g.act('p0', { type: 'call' });
    assert.deepEqual(types(end).slice(-4), ['round-end', 'showdown', 'win', 'hand-over']);
    s = g.getState();
    assert.equal(s.phase, 'hand-over');
    assert.equal(s.pot, 0);
    assert.deepEqual(s.lastResult.winners, [{ playerId: 'p0', amount: 85, potIndex: 0 }]);
    assert.deepEqual(s.players.map((p) => p.stack), [1050, 975, 975]);
    // The button moves only after the hand is fully resolved
    g.nextHand();
    s = g.getState();
    assert.equal(s.dealerIndex, 1);
    assert.equal(s.isSvara, false);
    assert.equal(s.svaraCount, 0);
    assert.equal(s.handNumber, 2);
  });

  test('decline: only the tied players play the svara', () => {
    const deck = rig([
      { p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' },
      { p1: 'Ks Kh Kd', p2: '8s 9h 10d' },
    ]);
    const g = game([1000, 1000, 1000], { deckProvider: deck });
    g.startHand();
    checkAround(g);
    const ev = g.svaraJoin('p0', false);
    assert.deepEqual(types(ev), ['svara-decline', 'svara-start', 'deal', 'deal', 'turn']);
    let s = g.getState();
    assert.equal(s.players[0].inHand, false);
    assert.equal(s.players[0].cards.length, 0);
    assert.equal(s.pot, 15);
    assert.deepEqual(deck.calls[1].order, ['p1', 'p2']);
    assert.throws(() => g.act('p0', { type: 'check' }), /not P0's turn/);
    checkAround(g);
    s = g.getState();
    assert.equal(s.phase, 'hand-over');
    assert.deepEqual(s.players.map((p) => p.stack), [995, 1010, 995]);
  });

  test('a player who cannot pay the join cost in full is not offered the svara', () => {
    const deck = rig([{ p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d', p3: '8c 9d 10s' }]);
    const g = game([1000, 1000, 1000, 1000], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'raise', amount: 500 });
    g.act('p2', { type: 'call' });
    g.act('p3', { type: 'fold' });
    g.act('p0', { type: 'fold' });
    const s = g.getState();
    // pot 20 + 1000 = 1020 → cost 510; p0/p3 have 995 → can pay
    assert.equal(s.svaraJoinCost, 510);
    assert.deepEqual(s.pendingSvaraDecisions, ['p3', 'p0']);

    const deck2 = rig([{ p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' }]);
    const g2 = game([300, 1000, 1000], { deckProvider: deck2 });
    g2.startHand();
    g2.act('p1', { type: 'raise', amount: 300 });
    g2.act('p2', { type: 'call' });
    const ev = g2.act('p0', { type: 'fold' });
    // pot 615 → cost 310 > p0's 295
    const offer = ev.find((e) => e.type === 'svara');
    assert.equal(offer.joinCost, 310);
    assert.deepEqual(offer.pending, []);
    const s2 = g2.getState();
    assert.equal(s2.phase, 'betting'); // nobody could join → the replay started at once
    assert.equal(s2.isSvara, true);
    assert.deepEqual(s2.pendingSvaraDecisions, []);
  });

  test('svara on a side pot only: the main pot is paid, the side pot goes to svara', () => {
    const deck = rig([
      { p1: '7s 7h 7d', p2: 'Ah Kh 9s', p0: 'Ad Kd 8s' },
      { p2: 'As Ah Ad', p0: '8h 9h 10d', p1: '8s 9d Jc' },
    ]);
    const g = game([1000, 100, 1000], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'allin' }); // 95
    g.act('p2', { type: 'raise', amount: 200 });
    const ev = g.act('p0', { type: 'call' });
    assert.deepEqual(types(ev), ['action', 'round-end', 'showdown', 'win', 'svara']);
    assert.deepEqual(ev[3], { type: 'win', playerId: 'p1', amount: 300, potIndex: 0, uncontested: false });
    assert.deepEqual(ev[4], { type: 'svara', participants: ['p2', 'p0'], svaraPot: 210, joinCost: 105, pending: ['p1'] });
    let s = g.getState();
    assert.equal(s.players[1].stack, 300);
    assert.equal(s.pot, 210);
    assert.equal(s.lastResult.svara, true);
    assert.deepEqual(s.lastResult.winners, [{ playerId: 'p1', amount: 300, potIndex: 0 }]);
    assert.equal(total(s), 2100);
    // the main pot winner can buy into the svara with the winnings
    const ev2 = g.svaraJoin('p1', true);
    assert.deepEqual(ev2[1], { type: 'svara-start', participants: ['p1', 'p2', 'p0'], pot: 315 });
    s = g.getState();
    assert.equal(s.players[1].stack, 195);
    checkAround(g);
    s = g.getState();
    assert.equal(s.phase, 'hand-over');
    assert.deepEqual(s.lastResult.winners, [{ playerId: 'p2', amount: 315, potIndex: 0 }]);
    assert.equal(total(s), 2100);
  });

  test('svara on the main pot while a single-player side pot is returned', () => {
    const deck = rig([{ p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' }, { p1: 'Ks Kh Kd', p2: '8s 9d Jc' }]);
    const g = game([1000, 1000, 205], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'raise', amount: 500 });
    g.act('p2', { type: 'allin' }); // 200
    g.act('p0', { type: 'fold' });
    const s = g.getState();
    // main: 205×2 + 5 = 415 → svara; p1's uncalled 300 comes back as a one-player side pot
    assert.equal(s.svaraPot, 415);
    assert.deepEqual(s.lastResult.winners, [{ playerId: 'p1', amount: 300, potIndex: 1 }]);
    assert.equal(s.players[1].stack, 795);
  });

  test('participants with no chips are all-in for the svara pot: straight to showdown', () => {
    const deck = rig([{ p0: 'Ah Kh 9s', p1: 'Ad Kd 8s' }, { p0: 'Ks Kh Kd', p1: '8s 9d Jc' }]);
    const g = game([105, 105], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'allin' });
    const ev = g.act('p0', { type: 'call' });
    assert.deepEqual(types(ev), [
      'action', 'round-end', 'showdown', 'svara', 'svara-start', 'deal', 'deal', 'round-end', 'showdown', 'win', 'hand-over',
    ]);
    const svara = ev.find((e) => e.type === 'svara');
    assert.deepEqual(svara.pending, []);
    const s = g.getState();
    assert.equal(s.phase, 'hand-over');
    assert.deepEqual(s.players.map((p) => p.stack), [210, 0]);
    assert.equal(s.isSvara, true);
    assert.equal(s.svaraCount, 1);
  });

  test('recursive svara: a tie in the replay starts another svara', () => {
    const deck = rig([
      { p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' },
      { p1: 'As Ks 9d', p2: 'Ac Kc 8d' },
      { p1: 'Js Jh Jd', p2: '8s 9h Qc' },
    ]);
    const g = game([1000, 1000, 1000], { deckProvider: deck });
    g.startHand();
    checkAround(g);
    g.svaraJoin('p0', false);
    let s = g.getState();
    assert.equal(s.svaraCount, 1);
    g.act('p1', { type: 'raise', amount: 10 });
    const ev = g.act('p2', { type: 'call' });
    assert.deepEqual(types(ev).slice(-3), ['round-end', 'showdown', 'svara']);
    s = g.getState();
    assert.equal(s.phase, 'svara-offer');
    assert.equal(s.svaraPot, 35);
    assert.equal(s.svaraJoinCost, 20); // ceil(35/2) = 18 → 20
    assert.deepEqual(s.pendingSvaraDecisions, ['p0']);
    g.svaraJoin('p0', false);
    s = g.getState();
    assert.equal(s.svaraCount, 2);
    assert.equal(s.isSvara, true);
    assert.equal(s.dealerIndex, 0);
    assert.equal(s.pot, 35);
    checkAround(g);
    s = g.getState();
    assert.equal(s.phase, 'hand-over');
    assert.deepEqual(s.players.map((p) => p.stack), [995, 1020, 985]);
    assert.equal(total(s), 3000);
  });

  test('a svara replay can be won uncontested (everyone else folds)', () => {
    const deck = rig([{ p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' }]);
    const g = game([1000, 1000, 1000], { deckProvider: deck });
    g.startHand();
    checkAround(g);
    g.svaraJoin('p0', true);
    g.act('p1', { type: 'raise', amount: 100 });
    g.act('p2', { type: 'fold' });
    const ev = g.act('p0', { type: 'fold' });
    assert.deepEqual(types(ev), ['action', 'round-end', 'win', 'hand-over']);
    assert.equal(ev[2].amount, 125);
    assert.equal(g.getState().players[1].stack, 1020);
  });

  test('svara with an odd pot rounds the join cost up to a multiple of the ante', () => {
    const deck = rig([{ p1: 'Ah Kh 9s', p2: 'Ad Kd 8s', p0: '8h 9h 10d' }]);
    const g = E.createGame({ players: mkPlayers([1000, 1000, 1000]), ante: 25, bb: 50, deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'raise', amount: 60 });
    g.act('p2', { type: 'call' });
    g.act('p0', { type: 'fold' });
    const s = g.getState();
    assert.equal(s.svaraPot, 195);
    assert.equal(s.svaraJoinCost, 100); // ceil(97.5) = 98 → 100
  });

  test('maxSvaras caps the replays: then a tie splits the pot', () => {
    const tie = { p0: 'Ah Kh 9s', p1: 'Ad Kd 8s' };
    const deck = rig([tie]);
    const g = game([105, 105], { deckProvider: deck, maxSvaras: 3 });
    g.startHand();
    g.act('p1', { type: 'allin' });
    const ev = g.act('p0', { type: 'call' });
    assert.equal(ev.filter((e) => e.type === 'svara').length, 3);
    const s = g.getState();
    assert.equal(s.phase, 'hand-over');
    assert.equal(s.svaraCount, 3);
    assert.deepEqual(s.players.map((p) => p.stack), [105, 105]);
  });
});

// --- between hands -----------------------------------------------------------

describe('between hands', () => {
  test('nextHand moves the button to the next seated player with chips', () => {
    const g = game([1000, 0, 1000, 1000]);
    g.startHand();
    assert.equal(g.getState().dealerIndex, 0);
    const seen = [];
    for (let i = 0; i < 5; i++) {
      checkAround(g);
      const s = g.getState();
      if (s.phase === 'svara-offer') for (const id of s.pendingSvaraDecisions) g.svaraJoin(id, false);
      while (g.getState().phase === 'betting') checkAround(g);
      if (g.getState().phase !== 'hand-over') continue;
      g.nextHand();
      seen.push(g.getState().dealerIndex);
    }
    assert.deepEqual(seen.slice(0, 3), [2, 3, 0]);
  });

  test('the button skips to a player with chips if the dealer seat is empty at the start', () => {
    const g = game([0, 1000, 1000]);
    g.startHand();
    const s = g.getState();
    assert.equal(s.dealerIndex, 1);
    assert.equal(s.toAct, 'p2');
  });

  test('setPlayer replaces or removes a seat between hands, addChips rebuys', () => {
    const g = game([1000, 1000, 1000]);
    g.startHand();
    g.act('p1', { type: 'fold' });
    g.act('p2', { type: 'fold' });
    assert.equal(g.getState().phase, 'hand-over');
    g.setPlayer(1, { id: 'iva', name: 'Ива', avatar: '🐭', stack: 600, isHuman: false, personality: 'fish' });
    assert.throws(() => g.setPlayer(2, { id: 'p0', name: 'dup', stack: 5 }), /already seated/);
    assert.throws(() => g.setPlayer(7, null), /seat must be/);
    g.addChips('p0', 100);
    assert.throws(() => g.addChips('p0', -5), /positive integer/);
    let s = g.getState();
    assert.deepEqual(s.players.map((p) => [p.id, p.seat, p.stack]), [['p0', 0, 1110], ['iva', 1, 600], ['p2', 2, 995]]);
    assert.equal(s.players[1].name, 'Ива');
    assert.equal(s.players[1].personality, 'fish');
    g.nextHand();
    s = g.getState();
    assert.equal(s.dealerIndex, 1);
    assert.equal(s.toAct, 'p2');
    assert.equal(s.players[1].inHand, true);
    checkAround(g);
    while (g.getState().phase !== 'hand-over') {
      const st = g.getState();
      if (st.phase === 'svara-offer') for (const id of st.pendingSvaraDecisions) g.svaraJoin(id, false);
      else checkAround(g);
    }
    g.setPlayer(1, null);
    s = g.getState();
    assert.deepEqual(s.players.map((p) => p.seat), [0, 2]);
    g.nextHand();
    assert.equal(g.getState().players.length, 2);
  });

  test('a busted player sits out; addChips brings them back', () => {
    const deck = rig([{ p1: 'Ah Kh Qh', p2: '8s 9h 10d', p0: '8h 9d Jc' }]);
    const g = game([1000, 1000, 105], { deckProvider: deck });
    g.startHand();
    g.act('p1', { type: 'raise', amount: 100 });
    g.act('p2', { type: 'call' });
    g.act('p0', { type: 'fold' });
    let s = g.getState();
    assert.equal(s.players[2].stack, 0);
    assert.equal(s.players[2].sittingOut, true);
    g.nextHand();
    s = g.getState();
    assert.equal(s.players[2].inHand, false);
    assert.equal(s.players[2].sittingOut, true);
    g.act(s.toAct, { type: 'fold' });
    g.addChips('p2', 200);
    assert.equal(g.getState().players[2].sittingOut, false);
    g.nextHand();
    assert.equal(g.getState().players[2].inHand, true);
  });

  test('jokerWild option reaches the showdown', () => {
    const hands = { p1: 'Ah Kh 7c', p2: 'As Ks Qs', p0: '8h 9d Jc' };
    for (const [jokerWild, winner] of [[true, 'p1'], [false, 'p2']]) {
      const g = game([1000, 1000, 1000], { deckProvider: rig([hands]), jokerWild });
      g.startHand();
      assert.equal(g.getState().jokerWild, jokerWild);
      checkAround(g);
      assert.equal(g.getState().lastResult.winners[0].playerId, winner);
    }
  });
});

// --- randomized invariants ---------------------------------------------------

function randomAction(L, rng) {
  const opts = [];
  if (L.canFold) opts.push(['fold', L.canCall ? 4 : 0.3]);
  if (L.canCheck) opts.push(['check', 5]);
  if (L.canCall) opts.push(['call', 5]);
  if (L.canRaise) opts.push(['raise', 2]);
  if (L.canAllIn) opts.push(['allin', 0.6]);
  const sum = opts.reduce((a, o) => a + o[1], 0);
  let r = rng() * sum;
  let type = opts[opts.length - 1][0];
  for (const [t, w] of opts) { if ((r -= w) < 0) { type = t; break; } }
  if (type !== 'raise') return { type };
  const span = L.maxRaiseTo - L.minRaiseTo;
  const amount = L.minRaiseTo + Math.floor(Math.pow(rng(), 3) * (span + 1));
  return { type, amount };
}

test('chip conservation and no stuck states over 2000 seeded random hands', () => {
  const rng = E.makeRng(2024);
  const stats = { hands: 0, svaras: 0, showdowns: 0, uncontested: 0, sidePots: 0, actions: 0, recursive: 0 };
  let newId = 0;
  for (let table = 0; table < 20; table++) {
    const stacks = Array.from({ length: 6 }, () => [3, 40, 120, 400, 1000][Math.floor(rng() * 5)]);
    const g = E.createGame({ players: mkPlayers(stacks), ante: 5, bb: 10, dealerIndex: Math.floor(rng() * 6), rng: E.makeRng(table + 1) });
    let expected = stacks.reduce((a, b) => a + b, 0);
    for (let h = 0; h < 100; h++) {
      // keep the table playable: rebuy or replace busted players
      if (h > 0) {
        const s = g.getState();
        for (const p of s.players) {
          if (p.stack > 0) continue;
          if (rng() < 0.5) { const amt = 50 + Math.floor(rng() * 500); g.addChips(p.id, amt); expected += amt; }
          else { const amt = 10 + Math.floor(rng() * 800); g.setPlayer(p.seat, { id: `n${newId++}`, name: 'N', avatar: '', stack: amt }); expected += amt; }
        }
      }
      const startEv = h === 0 ? g.startHand() : g.nextHand();
      stats.hands++;
      let events = startEv.slice();
      let steps = 0;
      let replayed = false; // a svara replay has started in this hand
      for (;;) {
        const s = g.getState();
        assert.equal(total(s), expected, 'chip conservation');
        assert.ok(s.players.every((p) => p.stack >= 0), 'no negative stacks');
        assert.equal(s.pots.reduce((a, p) => a + p.amount, 0), s.phase === 'hand-over' ? 0 : s.pot, 'pots add up');
        if (s.phase === 'hand-over') break;
        assert.ok(++steps < 400, 'hand must finish');
        if (s.phase === 'betting') {
          assert.ok(s.toAct, 'someone must be to act');
          const L = g.legalActions(s.toAct);
          assert.ok(L.isTurn && L.canFold);
          events = g.act(s.toAct, randomAction(L, rng));
          stats.actions++;
        } else if (s.phase === 'svara-offer') {
          assert.ok(s.pendingSvaraDecisions.length > 0);
          const id = s.pendingSvaraDecisions[Math.floor(rng() * s.pendingSvaraDecisions.length)];
          events = g.svaraJoin(id, rng() < 0.3);
        } else {
          assert.fail(`unexpected resting phase ${s.phase}`);
        }
        for (const e of events) {
          if (e.type === 'svara') { stats.svaras++; if (replayed) stats.recursive++; }
          if (e.type === 'svara-start') replayed = true;
          if (e.type === 'showdown') stats.showdowns++;
          if (e.type === 'win' && e.uncontested) stats.uncontested++;
          if (e.type === 'win' && e.potIndex > 0) stats.sidePots++;
        }
      }
      const s = g.getState();
      assert.equal(s.pot, 0);
      assert.equal(total(s), expected);
    }
  }
  assert.equal(stats.hands, 2000);
  // the random run must actually exercise the interesting paths
  assert.ok(stats.svaras > 20, `svaras: ${stats.svaras}`);
  assert.ok(stats.uncontested > 50, `uncontested: ${stats.uncontested}`);
  assert.ok(stats.sidePots > 50, `side pots: ${stats.sidePots}`);
  assert.ok(stats.showdowns > 500, `showdowns: ${stats.showdowns}`);
  assert.ok(stats.recursive > 0, `recursive svaras: ${stats.recursive}`);
});
