/*
 * Svara bots: Monte Carlo equity + personality-driven decisions. No DOM.
 * UMD classic script: browser global `SvaraAI` (needs `SvaraEngine` loaded first), Node `module.exports`.
 * Bots only look at their own cards and public information (pot, bets, who is still in).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.SvaraAI = factory(root.SvaraEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';
  if (!E) throw new Error('SvaraAI: load engine.js (SvaraEngine) before ai.js');

  // ---------------------------------------------------------------------------
  // Fast scoring: every 3-card hand pre-scored into a 32×32×32 lookup table
  // ---------------------------------------------------------------------------

  const DECK = E.newDeck();
  const INDEX = {};
  DECK.forEach((c, i) => { INDEX[c.id] = i; });
  const tables = {};

  function pointsTable(jokerWild) {
    const key = jokerWild ? 'wild' : 'plain';
    if (tables[key]) return tables[key];
    const t = new Uint8Array(32 * 32 * 32);
    for (let i = 0; i < 32; i++) {
      for (let j = i + 1; j < 32; j++) {
        for (let k = j + 1; k < 32; k++) {
          const pts = E.scoreHand([DECK[i], DECK[j], DECK[k]], { jokerWild }).points;
          for (const [a, b, c] of [[i, j, k], [i, k, j], [j, i, k], [j, k, i], [k, i, j], [k, j, i]]) {
            t[(a << 10) | (b << 5) | c] = pts;
          }
        }
      }
    }
    return (tables[key] = t);
  }

  function cardIndex(card) {
    const id = typeof card === 'string' ? card : card && card.id;
    const i = INDEX[id];
    if (i === undefined) throw new Error(`SvaraAI: invalid card ${JSON.stringify(card)}`);
    return i;
  }

  // Every 3-card hand (4960) as a card bitmask, strongest first, so "hands with at least N
  // points" is a prefix of the list: atLeast[N] = how many there are.
  const handLists = {};

  function handList(jokerWild) {
    const key = jokerWild ? 'wild' : 'plain';
    if (handLists[key]) return handLists[key];
    const table = pointsTable(jokerWild);
    const all = [];
    for (let i = 0; i < 32; i++) {
      for (let j = i + 1; j < 32; j++) {
        for (let k = j + 1; k < 32; k++) all.push({ pts: table[(i << 10) | (j << 5) | k], mask: (1 << i) | (1 << j) | (1 << k) });
      }
    }
    all.sort((a, b) => b.pts - a.pts);
    const masks = Int32Array.from(all, (h) => h.mask);
    const pts = Uint8Array.from(all, (h) => h.pts);
    const atLeast = new Uint16Array(36);
    for (let n = 0; n < 36; n++) atLeast[n] = all.filter((h) => h.pts >= n).length;
    return (handLists[key] = { masks, pts, atLeast });
  }

  /** A random hand from list[0 .. limit) that shares no card with `used` (strongest free hand as a fallback). */
  function drawFromList(list, limit, used, rng) {
    for (let tries = 0; tries < 100; tries++) {
      const h = Math.floor(rng() * limit);
      if ((list.masks[h] & used) === 0) return h;
    }
    for (let h = 0; h < list.masks.length; h++) if ((list.masks[h] & used) === 0) return h;
    return -1; // unreachable: at most 9 opponents leave free cards
  }

  /**
   * Monte Carlo equity of `myCards` against `numOpponents` hands dealt from the other 29 cards.
   * win = strictly best hand, tie = tied for best (→ svara).
   * By default every opponent holds a random hand. With `minPoints`, the first `bettors` opponents
   * (players who bet or raised) hold a hand of at least `minPoints`, except for a `bluffMix` share
   * of deals where they hold any hand.
   */
  function equity(myCards, numOpponents, {
    iterations = 1200, rng = Math.random, jokerWild = true, bettors = 0, minPoints = 0, bluffMix = 0.2,
  } = {}) {
    if (!Array.isArray(myCards) || myCards.length !== 3) throw new Error('equity: myCards must be 3 cards');
    const mine = myCards.map(cardIndex);
    if (new Set(mine).size !== 3) throw new Error('equity: duplicate cards');
    const table = pointsTable(jokerWild !== false);
    const myPoints = table[(mine[0] << 10) | (mine[1] << 5) | mine[2]];
    const n = Math.max(0, Math.min(9, Math.floor(numOpponents) || 0)); // 29 cards = at most 9 hands
    if (n === 0) return { win: 1, tie: 0 };
    const ranged = minPoints > 0 ? Math.max(0, Math.min(n, Math.floor(bettors) || 0)) : 0;
    const list = ranged ? handList(jokerWild !== false) : null;
    const strongLimit = ranged ? list.atLeast[Math.min(35, Math.floor(minPoints))] || list.masks.length : 0;
    const myMask = (1 << mine[0]) | (1 << mine[1]) | (1 << mine[2]);

    const rest = new Uint8Array(29);
    for (let i = 0, k = 0; i < 32; i++) if (!mine.includes(i)) rest[k++] = i;
    let size = 29; // cards in `rest`
    const iters = Math.max(1, Math.floor(iterations));
    let wins = 0;
    let ties = 0;
    for (let it = 0; it < iters; it++) {
      let best = 0;
      if (ranged) {
        // The bettors' hands come from their range (or, now and then, a bluff with any hand) ...
        let used = myMask;
        for (let o = 0; o < ranged; o++) {
          const limit = rng() < bluffMix ? list.masks.length : strongLimit;
          const h = drawFromList(list, limit, used, rng);
          used |= list.masks[h];
          if (list.pts[h] > best) best = list.pts[h];
        }
        // ... and the others get random cards from what is left.
        size = 0;
        for (let i = 0; i < 32; i++) if ((used & (1 << i)) === 0) rest[size++] = i;
      }
      let pos = 0;
      // Partial Fisher–Yates: draw 3 cards per opponent from the remaining deck.
      for (let o = ranged; o < n && best <= myPoints; o++) {
        for (let d = 0; d < 3; d++) {
          const j = pos + Math.floor(rng() * (size - pos));
          const t = rest[pos]; rest[pos] = rest[j]; rest[j] = t;
          pos++;
        }
        const pts = table[(rest[pos - 3] << 10) | (rest[pos - 2] << 5) | rest[pos - 1]];
        if (pts > best) best = pts;
      }
      if (myPoints > best) wins++;
      else if (myPoints === best) ties++;
    }
    return { win: wins / iters, tie: ties / iters };
  }

  // ---------------------------------------------------------------------------
  // Personalities
  // ---------------------------------------------------------------------------

  // tightness: how much equity it wants before putting chips in; aggression: bet/raise vs
  // check/call; bluff: how often it bets or raises with a weak hand.
  const PERSONALITIES = Object.freeze({
    rock: Object.freeze({ tightness: 0.85, aggression: 0.35, bluff: 0.03 }),
    tag: Object.freeze({ tightness: 0.65, aggression: 0.7, bluff: 0.08 }),
    lag: Object.freeze({ tightness: 0.4, aggression: 0.8, bluff: 0.16 }),
    fish: Object.freeze({ tightness: 0.2, aggression: 0.2, bluff: 0.05 }),
    maniac: Object.freeze({ tightness: 0.1, aggression: 0.95, bluff: 0.3 }),
  });

  function resolvePersonality(p) {
    if (typeof p === 'string' && PERSONALITIES[p]) return PERSONALITIES[p];
    if (p && typeof p === 'object') {
      const num = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
      return { tightness: num(p.tightness, 0.5), aggression: num(p.aggression, 0.5), bluff: num(p.bluff, 0.08) };
    }
    return PERSONALITIES.tag;
  }

  // ---------------------------------------------------------------------------
  // Betting decisions
  // ---------------------------------------------------------------------------

  /** Raise-to target: 2.5–3× the current bet or 50–100% of the pot, rounded to bb. */
  function raiseTarget(state, me, L, rng) {
    const bb = state.bb;
    let target;
    if (state.currentBet === 0) target = state.pot * (0.5 + 0.5 * rng());
    else if (rng() < 0.5) target = state.currentBet * (2.5 + 0.5 * rng());
    else target = state.currentBet + (state.pot + L.callAmount) * (0.5 + 0.5 * rng());
    let to = Math.round(target / bb) * bb;
    const minTo = Math.ceil(L.minRaiseTo / bb) * bb;
    if (to < minTo) to = minTo;
    // Committing most of the stack anyway: just move in.
    if (to - me.roundBet > 0.65 * me.stack) to = L.maxRaiseTo;
    return Math.min(to, L.maxRaiseTo);
  }

  /** Map an intent ('raise' | 'call' | 'check' | 'fold') to an action that is legal right now. */
  function toLegal(intent, state, me, L, rng) {
    if (intent === 'raise') {
      if (L.canRaise) {
        const to = raiseTarget(state, me, L, rng);
        if (to >= L.maxRaiseTo && L.canAllIn) return { type: 'allin' };
        if (to >= L.minRaiseTo && to <= L.maxRaiseTo) return { type: 'raise', amount: to };
      }
      // Can't make a full raise but may still shove for more than the call.
      if (L.canAllIn && L.allInAmount > L.callAmount) return { type: 'allin' };
      intent = 'call';
    }
    if (intent === 'call') {
      if (L.canCall) return { type: 'call' };
      if (L.canCheck) return { type: 'check' };
      if (L.canAllIn) return { type: 'allin' };
    }
    if (L.canCheck) return { type: 'check' }; // never fold for free
    return { type: 'fold' };
  }

  /**
   * Facing a bet, the opponents who bet or raised don't hold random hands. Their range gets
   * stronger with the size of the bet (relative to the pot before it) and with the number of
   * raisers: a min bet barely narrows it (≥ 18 points), a pot-sized bet means ≥ 19, a big shove
   * ≥ 25. About 1 in 5 bets is still read as a bluff with any hand.
   */
  function bettorRange(state, botId, live, L) {
    if (L.toCall <= 0) return {};
    const raisers = live.filter((p) => p.lastAction && (p.lastAction.type === 'raise' || p.lastAction.type === 'allin'));
    const bettors = raisers.filter((p) => p.id !== botId).length;
    if (!bettors) return {};
    const ratio = L.toCall / Math.max(state.bb, state.pot - L.toCall);
    const minPoints = Math.min(25, Math.round(17 + 1.5 * (raisers.length - 1) + 2 * Math.log2(1 + ratio)));
    return { bettors, minPoints, bluffMix: 0.2 };
  }

  /** Choose an action for `botId`. Always returns an action that is legal in `state`. */
  function decide(state, botId, personality, rng) {
    rng = typeof rng === 'function' ? rng : Math.random;
    const P = resolvePersonality(personality);
    const L = E.legalActions(state, botId);
    if (!L.isTurn) throw new Error(`SvaraAI.decide: it is not ${botId}'s turn`);
    const me = state.players.find((p) => p.id === botId);
    const jokerWild = state.jokerWild !== false;

    // Public info only: how many opponents are still in, the pot and the bets.
    const live = state.players.filter((p) => p.inHand && !p.folded);
    const nOpp = live.length - 1;
    const range = bettorRange(state, botId, live, L);
    const eq = equity(me.cards, nOpp, { iterations: 1200, rng, jokerWild, ...range });
    const points = E.scoreHand(me.cards, { jokerWild }).points;
    const monster = points >= 33;

    // A tie means a svara, where we keep a stake in the pot: count it as about half a win.
    const strength = eq.win + eq.tie * 0.5 + (rng() - 0.5) * 0.1;
    const fair = 1 / (nOpp + 1);
    const valueLine = fair + (1 - fair) * (0.22 + 0.25 * P.tightness - 0.15 * P.aggression);
    const call = L.callAmount;
    const potOdds = call > 0 ? call / (state.pot + call) : 0;

    let intent;
    if (L.canCheck) {
      if (strength >= valueLine) {
        const edge = strength - valueLine; // the stronger, the more often it bets
        if (monster && rng() < 0.3 + 0.2 * (1 - P.aggression)) intent = 'check'; // slow-play
        else intent = rng() < 0.45 + 0.4 * P.aggression + edge ? 'raise' : 'check';
      } else if (rng() < P.bluff * (nOpp <= 2 ? 1.2 : 0.6)) {
        intent = 'raise'; // bluff
      } else {
        intent = 'check';
      }
    } else {
      const need = potOdds * (0.8 + 0.6 * P.tightness);
      const committedShare = me.committed / Math.max(1, me.committed + me.stack);
      const canPush = L.canRaise || (L.canAllIn && L.allInAmount > call);
      if (strength >= valueLine + 0.05 && canPush) {
        const edge = strength - valueLine - 0.05;
        if (monster && rng() < 0.35) intent = 'call'; // slow-play: just call
        else intent = rng() < 0.2 + 0.45 * P.aggression + edge ? 'raise' : 'call';
      } else if (strength >= need || (committedShare > 0.5 && strength >= need * 0.6)) {
        intent = 'call';
      } else if (L.canRaise && call <= state.pot * 0.5 && rng() < P.bluff * 0.4) {
        intent = 'raise'; // re-raise bluff
      } else if (call <= me.stack * 0.15 && rng() < (1 - P.tightness) * 0.12) {
        intent = 'call'; // loose call now and then
      } else {
        intent = 'fold';
      }
    }
    return toLegal(intent, state, me, L, rng);
  }

  /**
   * Svara offer: join only if the cost is at most 40% of the stack; otherwise weigh the expected
   * share of the pot (svaraPot / (participants + 1)) against the cost, with personality and noise.
   */
  function decideSvaraJoin(state, botId, personality, rng) {
    rng = typeof rng === 'function' ? rng : Math.random;
    if (state.phase !== 'svara-offer' || !state.pendingSvaraDecisions.includes(botId)) return false;
    const me = state.players.find((p) => p.id === botId);
    const cost = state.svaraJoinCost;
    if (!me || cost <= 0 || cost > me.stack || cost > 0.4 * me.stack) return false;
    const P = resolvePersonality(personality);
    const share = state.svaraPot / (state.svaraParticipants.length + 1);
    const ratio = share / cost;
    let p = 0.1 + (ratio - 0.5) * 0.9 + (P.aggression - 0.5) * 0.3 - (P.tightness - 0.5) * 0.3 + P.bluff * 0.2;
    p = Math.max(0.02, Math.min(0.9, p));
    return rng() < p;
  }

  return { equity, decide, decideSvaraJoin, PERSONALITIES };
});
