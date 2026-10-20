/*
 * Svara rules engine: deck, hand scoring and the betting / showdown / svara state machine.
 * No DOM. UMD classic script: browser global `SvaraEngine`, Node `module.exports`.
 * The public contract is described in docs/SPEC.md §3.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SvaraEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------

  const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUITS = ['s', 'h', 'd', 'c'];
  const VALUES = { 7: 7, 8: 8, 9: 9, 10: 10, J: 10, Q: 10, K: 10, A: 11 };
  const JOKER_VALUE = 11;
  const TRIPS_LABELS = {
    A: 'Три аса', K: 'Три попа', Q: 'Три дами', J: 'Три валета',
    10: 'Три десетки', 9: 'Три деветки', 8: 'Три осмици',
  };
  // When two candidates give the same points, the "special" kind wins.
  const KIND_PRIORITY = { three7: 4, trips: 3, aces: 2, suit: 1 };

  function makeCard(rank, suit) {
    return { rank, suit, id: rank + suit };
  }

  /** 'Ah' / '10d' -> card object. */
  function parseCard(id) {
    if (typeof id !== 'string' || id.length < 2) throw new Error(`Invalid card id: ${id}`);
    const rank = id.slice(0, -1);
    const suit = id.slice(-1);
    if (!RANKS.includes(rank) || !SUITS.includes(suit)) throw new Error(`Invalid card id: ${id}`);
    return makeCard(rank, suit);
  }

  /** Accepts a card object or a card id; returns a fresh card object. */
  function toCard(c) {
    if (typeof c === 'string') return parseCard(c);
    if (!c || !RANKS.includes(c.rank) || !SUITS.includes(c.suit)) {
      throw new Error(`Invalid card: ${JSON.stringify(c)}`);
    }
    return makeCard(c.rank, c.suit);
  }

  /** Face value of a card (7♣ is 7 here; its wild value 11 is applied by scoreHand). */
  function cardValue(card) {
    return VALUES[toCard(card).rank];
  }

  function isJoker(card, jokerWild = true) {
    return !!jokerWild && !!card && card.rank === '7' && card.suit === 'c';
  }

  function newDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push(makeCard(r, s));
    return deck;
  }

  /** In-place Fisher–Yates shuffle; rng() must return a number in [0, 1). */
  function shuffle(deck, rng = Math.random) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  /** mulberry32 PRNG: deterministic, good enough for games and tests. */
  function makeRng(seed) {
    let a = (seed >>> 0) || 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // Scoring (SPEC §1)
  // ---------------------------------------------------------------------------

  /**
   * Score a Svara hand (normally 3 cards; 1–2 cards are scored the same way).
   * Returns { points, kind: 'three7'|'trips'|'aces'|'suit', label, usedCardIds }.
   */
  function scoreHand(cards, { jokerWild = true } = {}) {
    if (!Array.isArray(cards) || cards.length < 1 || cards.length > 3) {
      throw new Error('scoreHand expects an array of 1 to 3 cards');
    }
    const cs = cards.map(toCard);
    const ids = cs.map((c) => c.id);
    if (new Set(ids).size !== ids.length) throw new Error(`scoreHand: duplicate cards ${ids.join(' ')}`);
    const jokers = cs.filter((c) => isJoker(c, jokerWild));
    const naturals = cs.filter((c) => !isJoker(c, jokerWild));
    const candidates = [];

    if (cs.length === 3) {
      if (cs.every((c) => c.rank === '7')) {
        // Three 7s (7♣ is a 7 whether or not it is wild).
        candidates.push({ points: 34, kind: 'three7', label: 'Три седмици', usedCardIds: ids });
      } else if (naturals.every((c) => c.rank === naturals[0].rank)) {
        // Natural trips, or joker + a pair completing the trips.
        const r = naturals[0].rank;
        candidates.push({ points: VALUES[r] * 3, kind: 'trips', label: TRIPS_LABELS[r], usedCardIds: ids });
      }
    }

    const aces = naturals.filter((c) => c.rank === 'A');
    if (aces.length >= 2) {
      candidates.push({ points: 22, kind: 'aces', label: 'Два аса', usedCardIds: aces.slice(0, 2).map((c) => c.id) });
    }

    // Best suit: natural cards of the suit + 11 for the joker (it joins any suit).
    let best = null;
    for (const s of SUITS) {
      const inSuit = naturals.filter((c) => c.suit === s);
      if (!inSuit.length) continue;
      const points = inSuit.reduce((sum, c) => sum + VALUES[c.rank], 0) + jokers.length * JOKER_VALUE;
      if (!best || points > best.points) {
        const used = new Set(inSuit.concat(jokers).map((c) => c.id));
        best = { points, kind: 'suit', label: `${points} точки`, usedCardIds: ids.filter((id) => used.has(id)) };
      }
    }
    if (!best) best = { points: JOKER_VALUE, kind: 'suit', label: `${JOKER_VALUE} точки`, usedCardIds: ids };
    candidates.push(best);

    let pick = candidates[0];
    for (const c of candidates) {
      if (c.points > pick.points || (c.points === pick.points && KIND_PRIORITY[c.kind] > KIND_PRIORITY[pick.kind])) {
        pick = c;
      }
    }
    return { points: pick.points, kind: pick.kind, label: pick.label, usedCardIds: pick.usedCardIds.slice() };
  }

  /** Comparator: negative when a is better (sorts best first), 0 = tie (svara). */
  function compareScores(a, b) {
    return b.points - a.points;
  }

  // ---------------------------------------------------------------------------
  // Legal actions (pure function of a state; used by the game and by the AI)
  // ---------------------------------------------------------------------------

  /**
   * Legal actions for `playerId` in `state` (a game's internal state or a getState() snapshot).
   * Amounts are always filled in for a player in the hand; the can* flags are true only on
   * that player's turn.
   */
  function legalActions(state, playerId) {
    const p = state.players.find((q) => q.id === playerId);
    if (!p) throw new Error(`legalActions: unknown player '${playerId}'`);
    const bet = state.currentBet;
    const live = p.inHand && !p.folded;
    const toCall = live ? Math.max(0, bet - p.roundBet) : 0;
    const res = {
      canFold: false, canCheck: false, callAmount: Math.min(toCall, p.stack), canCall: false,
      canRaise: false, minRaiseTo: state.minRaiseTo, maxRaiseTo: live ? p.roundBet + p.stack : 0,
      canAllIn: false, allInAmount: live ? p.stack : 0, isBet: bet === 0,
      // extras
      isTurn: false, toCall, callIsAllIn: live && toCall > 0 && p.stack <= toCall,
    };
    if (state.phase !== 'betting' || state.toAct !== playerId || !live || p.allIn || p.stack <= 0) return res;

    res.isTurn = true;
    const unit = Math.max(state.lastRaiseSize || 0, state.bb);
    // Someone else must be able to respond, otherwise raising is pointless (and not allowed).
    const opponentCanAct = state.players.some((q) => q.id !== p.id && q.inHand && !q.folded && !q.allIn);
    // Betting is (re)opened for a player who hasn't acted yet, or who faces at least a full
    // raise since they last acted (incomplete all-ins don't reopen the action).
    const reopened = !p.acted || bet - p.actedAtBet >= unit;
    const raiseRight = reopened && opponentCanAct;

    res.canFold = true;
    res.canCheck = toCall === 0;
    res.canCall = toCall > 0;
    res.canRaise = raiseRight && res.maxRaiseTo >= state.minRaiseTo;
    res.canAllIn = p.stack <= toCall || (raiseRight && res.maxRaiseTo > bet);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Game
  // ---------------------------------------------------------------------------

  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

  function assertPosInt(v, name) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer (got ${v})`);
  }

  function createGame(config) {
    const cfg = config || {};
    if (!Array.isArray(cfg.players) || cfg.players.length < 2) {
      throw new Error('createGame: players must be an array with at least 2 seats');
    }
    assertPosInt(cfg.ante, 'ante');
    assertPosInt(cfg.bb, 'bb');
    const rng = typeof cfg.rng === 'function' ? cfg.rng : Math.random;
    const jokerWild = cfg.jokerWild !== false;
    // Safety valve: after this many svara replays in one hand, a tie splits the pot instead.
    const maxSvaras = cfg.maxSvaras == null ? 10 : cfg.maxSvaras;
    // Test hook: ({ handNumber, isSvara, svaraCount, order }) -> card[] | id[] (top first;
    // order[k] gets cards 3k..3k+2). Defaults to a freshly shuffled deck.
    const deckProvider = typeof cfg.deckProvider === 'function' ? cfg.deckProvider : null;
    const numSeats = cfg.players.length;
    const dealerIndex = cfg.dealerIndex == null ? 0 : cfg.dealerIndex;
    if (!Number.isInteger(dealerIndex) || dealerIndex < 0 || dealerIndex >= numSeats) {
      throw new Error(`createGame: dealerIndex must be a seat index 0..${numSeats - 1}`);
    }

    const S = {
      phase: 'idle', handNumber: 0, isSvara: false, svaraCount: 0,
      dealerIndex, toAct: null,
      currentBet: 0, lastRaiseSize: 0, minRaiseTo: cfg.bb, ante: cfg.ante, bb: cfg.bb,
      pot: 0, deadMoney: 0,
      svaraPot: 0, svaraParticipants: [], svaraJoinCost: 0, pendingSvaraDecisions: [],
      players: [], // occupied seats only, sorted by seat
      lastResult: null,
    };

    function makePlayer(input, seat) {
      if (!input || typeof input !== 'object') throw new Error(`Seat ${seat}: player must be an object`);
      if (input.id == null || input.id === '') throw new Error(`Seat ${seat}: player needs an id`);
      const stack = input.stack == null ? 0 : input.stack;
      if (!Number.isInteger(stack) || stack < 0) throw new Error(`Seat ${seat}: stack must be a non-negative integer`);
      const p = {
        id: input.id, name: input.name == null ? String(input.id) : input.name, avatar: input.avatar || '',
        isHuman: !!input.isHuman, seat, stack,
        roundBet: 0, committed: 0, folded: false, allIn: false, inHand: false, sittingOut: stack === 0,
        cards: [], lastAction: null, score: null, acted: false, actedAtBet: 0,
      };
      if (input.personality !== undefined) p.personality = input.personality;
      return p;
    }

    function placePlayer(seat, input) {
      const p = makePlayer(input, seat);
      if (S.players.some((q) => q.id === p.id && q.seat !== seat)) {
        throw new Error(`Player id '${p.id}' is already seated`);
      }
      S.players = S.players.filter((q) => q.seat !== seat);
      S.players.push(p);
      S.players.sort((a, b) => a.seat - b.seat);
    }

    cfg.players.forEach((input, seat) => { if (input) placePlayer(seat, input); });
    if (S.players.length < 2) throw new Error('createGame: at least 2 seated players are required');

    // --- helpers -------------------------------------------------------------

    function byId(id) {
      const p = S.players.find((q) => q.id === id);
      if (!p) throw new Error(`Unknown player '${id}'`);
      return p;
    }
    const isLive = (p) => p.inHand && !p.folded;

    /** Seated players clockwise, starting with the seat after `seat`. */
    function orderFrom(seat) {
      const off = (p) => (p.seat - seat - 1 + numSeats * 2) % numSeats;
      return S.players.slice().sort((a, b) => off(a) - off(b));
    }

    function nextSeatWithChips(seat) {
      const p = orderFrom(seat).find((q) => q.stack > 0);
      return p ? p.seat : seat;
    }

    function betweenHands(what) {
      if (S.phase !== 'idle' && S.phase !== 'hand-over') {
        throw new Error(`${what}: only allowed between hands (phase is '${S.phase}')`);
      }
    }

    function resetForDeal(p, inHand) {
      p.roundBet = 0; p.committed = 0; p.folded = false; p.allIn = false; p.inHand = inHand;
      p.cards = []; p.lastAction = null; p.score = null; p.acted = false; p.actedAtBet = 0;
    }

    /** Move chips from a stack into the middle as part of this deal. */
    function put(p, amount, isAnte) {
      p.stack -= amount;
      p.committed += amount;
      if (!isAnte) p.roundBet += amount;
      S.pot += amount;
      if (p.stack === 0) p.allIn = true;
    }

    function getDeck(order) {
      if (!deckProvider) return shuffle(newDeck(), rng);
      const deck = deckProvider({ handNumber: S.handNumber, isSvara: S.isSvara, svaraCount: S.svaraCount, order: order.slice() });
      if (!Array.isArray(deck)) throw new Error('deckProvider must return an array of cards');
      const cards = deck.map(toCard);
      if (new Set(cards.map((c) => c.id)).size !== cards.length) throw new Error('deckProvider returned duplicate cards');
      if (cards.length < order.length * 3) throw new Error('deckProvider returned too few cards');
      return cards;
    }

    function dealCards(events) {
      const order = orderFrom(S.dealerIndex).filter((p) => p.inHand);
      const deck = getDeck(order.map((p) => p.id));
      order.forEach((p, k) => {
        p.cards = deck.slice(k * 3, k * 3 + 3).map(toCard);
        events.push({ type: 'deal', playerId: p.id, count: 3 });
      });
    }

    function needsAction(p) {
      if (!p.inHand || p.folded || p.allIn) return false;
      if (p.roundBet < S.currentBet) return true;
      if (p.acted) return false;
      // Not acted yet: only needed if somebody could still respond to a bet.
      return S.players.some((q) => q !== p && q.inHand && !q.folded && !q.allIn);
    }

    function beginBetting(events) {
      S.phase = 'betting';
      S.currentBet = 0;
      S.lastRaiseSize = 0;
      S.minRaiseTo = S.bb;
      const first = orderFrom(S.dealerIndex).find(needsAction);
      if (first) {
        S.toAct = first.id;
        events.push({ type: 'turn', playerId: first.id });
      } else {
        // Nobody can bet (everyone all-in, or only one player with chips): straight to showdown.
        endRound(events);
      }
    }

    /**
     * Pots from committed chips (the standard side-pot construction) + dead svara money.
     * Each all-in player caps a pot at their committed amount; the top pot takes the rest.
     * Live players who are not all-in are eligible for every pot (they can still match).
     */
    function buildPots() {
      const live = orderFrom(S.dealerIndex).filter(isLive);
      if (!live.length) return [];
      const top = Math.max(...live.map((p) => p.committed));
      const caps = live.filter((p) => p.allIn && p.committed < top).map((p) => p.committed);
      const levels = Array.from(new Set(caps)).sort((a, b) => a - b).concat(top);
      const pots = [];
      let prev = 0;
      levels.forEach((level, i) => {
        let amount = 0;
        for (const p of S.players) amount += Math.min(p.committed, level) - Math.min(p.committed, prev);
        if (i === 0) amount += S.deadMoney; // svara money is winnable by every live participant
        pots.push({ amount, eligible: live.filter((p) => !p.allIn || p.committed >= level).map((p) => p.id) });
        prev = level;
      });
      // Defensive: chips of folded players above the top live level go to the top pot.
      const extra = S.players.reduce((sum, p) => sum + Math.max(0, p.committed - prev), 0);
      if (pots.length) pots[pots.length - 1].amount += extra;
      return pots.filter((pot) => pot.amount > 0);
    }

    function pay(p, amount, potIndex, uncontested, winners, events) {
      p.stack += amount;
      S.pot -= amount;
      winners.push({ playerId: p.id, amount, potIndex });
      events.push({ type: 'win', playerId: p.id, amount, potIndex, uncontested });
    }

    /** Split a pot; odd chips go one by one in seat order starting left of the dealer. */
    function splitPot(players, amount, potIndex, winners, events) {
      const ids = new Set(players.map((p) => p.id));
      const ordered = orderFrom(S.dealerIndex).filter((p) => ids.has(p.id));
      const share = Math.floor(amount / ordered.length);
      let rest = amount - share * ordered.length;
      for (const p of ordered) {
        const extra = rest > 0 ? 1 : 0;
        rest -= extra;
        pay(p, share + extra, potIndex, false, winners, events);
      }
    }

    function endRound(events) {
      events.push({ type: 'round-end', pot: S.pot });
      for (const p of S.players) p.roundBet = 0;
      S.toAct = null;
      S.currentBet = 0;
      S.lastRaiseSize = 0;
      S.minRaiseTo = S.bb;
      const live = S.players.filter(isLive);
      if (live.length === 1) awardUncontested(live[0], events);
      else showdown(events);
    }

    function awardUncontested(winner, events) {
      const winners = [];
      pay(winner, S.pot, 0, true, winners, events);
      S.lastResult = { winners, svara: false, scores: {}, uncontested: true };
      finishHand(events);
    }

    function showdown(events) {
      S.phase = 'showdown';
      const contenders = orderFrom(S.dealerIndex).filter(isLive);
      const scores = {};
      const cards = {};
      for (const p of contenders) {
        p.score = scoreHand(p.cards, { jokerWild });
        scores[p.id] = clone(p.score);
        cards[p.id] = clone(p.cards);
      }
      events.push({ type: 'showdown', scores, cards });

      const winners = [];
      const tied = new Set();
      let toSvara = 0;
      buildPots().forEach((pot, i) => {
        const eligible = pot.eligible.map(byId);
        const best = Math.max(...eligible.map((p) => p.score.points));
        const top = eligible.filter((p) => p.score.points === best);
        if (top.length === 1) pay(top[0], pot.amount, i, false, winners, events);
        else if (S.svaraCount < maxSvaras) {
          toSvara += pot.amount;
          top.forEach((p) => tied.add(p.id));
        } else splitPot(top, pot.amount, i, winners, events);
      });
      S.lastResult = { winners, svara: toSvara > 0, scores: clone(scores), uncontested: false };
      if (toSvara > 0) {
        const participants = orderFrom(S.dealerIndex).filter((p) => tied.has(p.id)).map((p) => p.id);
        beginSvaraOffer(participants, toSvara, events);
      } else {
        finishHand(events);
      }
    }

    function beginSvaraOffer(participants, amount, events) {
      S.phase = 'svara-offer';
      S.toAct = null;
      S.deadMoney = 0;
      S.svaraPot = amount;
      S.svaraParticipants = participants.slice();
      // ceil(pot / 2), rounded up to a multiple of the ante
      S.svaraJoinCost = Math.ceil(Math.ceil(amount / 2) / S.ante) * S.ante;
      S.pendingSvaraDecisions = orderFrom(S.dealerIndex)
        .filter((p) => !participants.includes(p.id) && p.stack > 0 && p.stack >= S.svaraJoinCost)
        .map((p) => p.id);
      events.push({
        type: 'svara', participants: participants.slice(), svaraPot: amount,
        joinCost: S.svaraJoinCost, pending: S.pendingSvaraDecisions.slice(),
      });
      if (!S.pendingSvaraDecisions.length) startSvaraDeal(events);
    }

    function startSvaraDeal(events) {
      S.svaraCount += 1;
      S.isSvara = true;
      S.svaraJoinCost = 0;
      S.pendingSvaraDecisions = [];
      S.deadMoney = S.svaraPot;
      const ids = new Set(S.svaraParticipants);
      S.svaraParticipants = orderFrom(S.dealerIndex).filter((p) => ids.has(p.id)).map((p) => p.id);
      events.push({ type: 'svara-start', participants: S.svaraParticipants.slice(), pot: S.pot });
      for (const p of S.players) {
        resetForDeal(p, ids.has(p.id));
        if (p.inHand && p.stack === 0) p.allIn = true; // all-in for the svara pot
      }
      dealCards(events); // fresh deck, no ante; the button stays put
      beginBetting(events);
    }

    function finishHand(events) {
      S.phase = 'hand-over';
      S.toAct = null;
      S.deadMoney = 0;
      S.svaraPot = 0;
      S.svaraParticipants = [];
      S.svaraJoinCost = 0;
      S.pendingSvaraDecisions = [];
      for (const p of S.players) p.sittingOut = p.stack === 0;
      events.push({ type: 'hand-over' });
    }

    // --- public API ----------------------------------------------------------

    function startHand() {
      betweenHands('startHand');
      if (S.players.filter((p) => p.stack > 0).length < 2) {
        throw new Error('startHand: at least 2 players with chips are needed');
      }
      const dealer = S.players.find((p) => p.seat === S.dealerIndex);
      if (!dealer || dealer.stack === 0) S.dealerIndex = nextSeatWithChips(S.dealerIndex);

      S.handNumber += 1;
      S.isSvara = false;
      S.svaraCount = 0;
      S.pot = 0;
      S.deadMoney = 0;
      S.svaraPot = 0;
      S.svaraParticipants = [];
      S.svaraJoinCost = 0;
      S.pendingSvaraDecisions = [];
      S.lastResult = null;
      S.toAct = null;
      for (const p of S.players) {
        resetForDeal(p, p.stack > 0);
        p.sittingOut = p.stack === 0;
      }

      const events = [{ type: 'hand-start', handNumber: S.handNumber, dealerIndex: S.dealerIndex }];
      for (const p of orderFrom(S.dealerIndex).filter((q) => q.inHand)) {
        const amount = Math.min(S.ante, p.stack); // short stack: all-in on the ante
        put(p, amount, true);
        events.push({ type: 'ante', playerId: p.id, amount, allIn: p.allIn });
      }
      dealCards(events);
      beginBetting(events);
      return events;
    }

    function act(playerId, action) {
      if (S.phase !== 'betting') throw new Error(`act: no betting in phase '${S.phase}'`);
      const p = byId(playerId);
      if (S.toAct !== p.id) throw new Error(`act: it is not ${p.name}'s turn (waiting for '${S.toAct}')`);
      if (!action || typeof action.type !== 'string') throw new Error('act: action must be { type, amount? }');
      const L = legalActions(S, p.id);
      const betBefore = S.currentBet;
      const stackBefore = p.stack;
      const type = action.type;

      switch (type) {
        case 'fold':
          p.folded = true;
          break;
        case 'check':
          if (!L.canCheck) throw new Error(`act: cannot check, ${L.toCall} to call`);
          break;
        case 'call':
          if (!L.canCall) throw new Error('act: nothing to call (use check)');
          put(p, L.callAmount);
          break;
        case 'raise': {
          const to = action.amount;
          if (!Number.isInteger(to)) throw new Error('act: raise needs an integer amount (the raise-to total)');
          if (to === L.maxRaiseTo && L.canAllIn && to > betBefore) { put(p, p.stack); break; } // all-in raise
          if (!L.canRaise) {
            throw new Error(L.maxRaiseTo < L.minRaiseTo && L.maxRaiseTo > betBefore
              ? `act: not enough chips for a full raise; raise all-in to ${L.maxRaiseTo} or use allin`
              : 'act: raising is not allowed now (call or fold)');
          }
          if (to < L.minRaiseTo) throw new Error(`act: raise to ${to} is below the minimum ${L.minRaiseTo}`);
          if (to > L.maxRaiseTo) throw new Error(`act: raise to ${to} is more than the stack allows (${L.maxRaiseTo})`);
          put(p, to - p.roundBet);
          break;
        }
        case 'allin':
          if (!L.canAllIn) throw new Error('act: all-in is not allowed now (it would be a raise; call or fold)');
          put(p, p.stack);
          break;
        default:
          throw new Error(`act: unknown action type '${type}'`);
      }

      if (p.roundBet > S.currentBet) {
        const increase = p.roundBet - S.currentBet;
        if (increase >= Math.max(S.lastRaiseSize, S.bb)) S.lastRaiseSize = increase; // a full raise
        S.currentBet = p.roundBet;
      }
      S.minRaiseTo = S.currentBet + Math.max(S.lastRaiseSize, S.bb);
      p.acted = true;
      p.actedAtBet = S.currentBet;

      const added = stackBefore - p.stack;
      const reported = type !== 'fold' && p.allIn ? 'allin' : type;
      const amount = reported === 'raise' || reported === 'allin' ? p.roundBet : added;
      const record = { type: reported, amount, added, isBet: (reported === 'raise' || reported === 'allin') && betBefore === 0 };
      p.lastAction = clone(record);
      const events = [{ type: 'action', playerId: p.id, action: record, stack: p.stack, roundBet: p.roundBet }];

      const live = S.players.filter(isLive);
      if (live.length === 1) {
        endRound(events); // everyone else folded: uncontested, no showdown
        return events;
      }
      const next = orderFrom(p.seat).find(needsAction);
      if (next) {
        S.toAct = next.id;
        events.push({ type: 'turn', playerId: next.id });
      } else {
        endRound(events);
      }
      return events;
    }

    function svaraJoin(playerId, join) {
      if (S.phase !== 'svara-offer') throw new Error(`svaraJoin: no svara offer in phase '${S.phase}'`);
      const p = byId(playerId);
      if (!S.pendingSvaraDecisions.includes(p.id)) {
        throw new Error(`svaraJoin: ${p.name} has no pending svara decision`);
      }
      S.pendingSvaraDecisions = S.pendingSvaraDecisions.filter((id) => id !== p.id);
      const events = [];
      if (join) {
        const paid = S.svaraJoinCost;
        p.stack -= paid;
        S.pot += paid;
        S.svaraPot += paid;
        S.svaraParticipants.push(p.id);
        events.push({ type: 'svara-join', playerId: p.id, paid });
      } else {
        events.push({ type: 'svara-decline', playerId: p.id });
      }
      if (!S.pendingSvaraDecisions.length) startSvaraDeal(events);
      return events;
    }

    function nextHand() {
      if (S.phase === 'idle') return startHand();
      if (S.phase !== 'hand-over') throw new Error(`nextHand: the hand is not over (phase '${S.phase}')`);
      if (S.players.filter((p) => p.stack > 0).length < 2) {
        throw new Error('nextHand: at least 2 players with chips are needed');
      }
      S.dealerIndex = nextSeatWithChips(S.dealerIndex);
      return startHand();
    }

    function setPlayer(seatIndex, player) {
      betweenHands('setPlayer');
      if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= numSeats) {
        throw new Error(`setPlayer: seat must be 0..${numSeats - 1}`);
      }
      if (player == null) S.players = S.players.filter((p) => p.seat !== seatIndex);
      else placePlayer(seatIndex, player);
    }

    function addChips(playerId, amount) {
      betweenHands('addChips');
      assertPosInt(amount, 'addChips amount');
      const p = byId(playerId);
      p.stack += amount;
      p.sittingOut = false;
    }

    function currentPots() {
      if (S.phase === 'betting' || S.phase === 'showdown') return buildPots();
      if (S.phase === 'svara-offer') return [{ amount: S.svaraPot, eligible: S.svaraParticipants.slice() }];
      return [];
    }

    function getState() {
      return clone({
        phase: S.phase, handNumber: S.handNumber, isSvara: S.isSvara, svaraCount: S.svaraCount,
        dealerIndex: S.dealerIndex, toAct: S.toAct,
        currentBet: S.currentBet, minRaiseTo: S.minRaiseTo, lastRaiseSize: S.lastRaiseSize,
        ante: S.ante, bb: S.bb, jokerWild, numSeats,
        pot: S.pot, pots: currentPots(),
        svaraPot: S.svaraPot, svaraParticipants: S.svaraParticipants, svaraJoinCost: S.svaraJoinCost,
        pendingSvaraDecisions: S.pendingSvaraDecisions,
        players: S.players,
        lastResult: S.lastResult,
      });
    }

    return {
      startHand, getState, act, svaraJoin, nextHand, setPlayer, addChips,
      legalActions: (playerId) => legalActions(S, playerId),
    };
  }

  return {
    RANKS: RANKS.slice(), SUITS: SUITS.slice(),
    cardValue, isJoker, newDeck, shuffle, makeRng, parseCard, scoreHand, compareScores,
    legalActions, createGame,
  };
});
