# Свара — AI Арена (v1 spec)

A mobile-first web game of the Bulgarian card game **Свара**, recreating the look and flow of a
minimalist poker app the user recorded (frames: see "Reference video" below). v1 = **you vs 5
computer players**, UI in **Bulgarian**, screens: **Home → Stakes picker → Table** (+ leave-table
sheet). No real money, no online play.

---

## 1. Rules (standard Svara)

### Deck & deal
- 32 cards: ranks `7 8 9 10 J Q K A`, suits `s h d c` (♠ ♥ ♦ ♣).
- Each player gets **3 cards**.

### Card values
| Card | Value |
|---|---|
| 7, 8, 9 | 7, 8, 9 |
| 10, J, Q, K | 10 |
| A | 11 |

### The joker: 7♣ (Йончо / Шпока)
- With `jokerWild: true` (the default), 7♣ is wild. It counts **11** and can join any suit or complete a
  three of a kind.
- With `jokerWild: false`, it is an ordinary 7 of clubs. Keep this as an engine option; the UI always uses `true`.

### Hand score = the best of these candidates
1. **Three 7s** → **34**. This is the strongest hand. 7♣ is a 7, so 7♣ 7♥ 7♦ counts.
2. **Three of a kind** (all three the same rank) → **sum of the values**: AAA=33, KKK=QQQ=JJJ=101010=30,
   999=27, 888=24.
   - With the joker, joker + a pair of rank R → three of R (e.g. A♥ A♠ 7♣ = 33, 9♥ 9♦ 7♣ = 27).
3. **Two aces** (any suits) → **22**.
4. **Suit sum**: for each suit, add the values of the non-joker cards of that suit. If the joker is
   present, add 11 to every suit. Take the best suit. One card alone counts its own value, so
   every hand scores at least its highest card (or 11 with the joker).
   - Examples: A♥ K♥ Q♥ = 31; A♥ K♥ 7♣ = 32; K♦ Q♦ 10♠ = 20; 9♥ 8♠ 7♣ = 20; 8♠ 9♥ 10♦ = 10.

`points = max(candidates)`. The `kind` is the candidate that produced the max. If several candidates give the same
max, prefer the special kind (three7 > trips > aces > suit).

### Comparing hands
- More points wins. **No kickers.** Equal points means a tie, which triggers a **Свара**.

### Hand labels (Bulgarian, shown in the UI)
| kind | label |
|---|---|
| three7 | `Три седмици` |
| trips | `Три аса`, `Три попа`, `Три дами`, `Три валета`, `Три десетки`, `Три деветки`, `Три осмици` |
| aces | `Два аса` |
| suit | `{points} точки` |

### Betting (one round, no-limit)
- **Stakes** "5 / 10" mean **ante 5**, **minimum bet 10** (the "big stake" `bb`).
- At the start of each normal hand, every seated player with chips pays the **ante**. A player with
  less than the ante goes all-in for what they have.
- Betting starts with the first active player **left of the dealer** (seat order = array order,
  wrapping) and goes clockwise.
- Actions:
  - `fold` (Пас)
  - `check` (Чек), only when there's nothing to call
  - `call` (Плащам N)
  - `raise` to a total (Залагам N when the current bet is 0, otherwise Вдигам N)
  - `allin` (Ва банк)
- **Minimum raise-to** = `currentBet + max(lastFullRaiseSize, bb)`. The first bet must be at least `bb`.
  **Maximum** = everything the player has.
- An all-in below a full raise does **not** reopen betting for players who already acted. They can
  only call or fold. This is the standard no-limit rule.
- The round ends when:
  - only one player hasn't folded → they win the whole pot immediately. **No showdown, and no cards
    are shown.**
  - or every player who hasn't folded is either all-in or has acted since the last full raise
    and matched `currentBet` → **showdown**.
- **Side pots** are built from each player's total committed chips (ante included), the standard way.
- **Split pots**: odd chips go to the winners in seat order, starting left of the dealer.

### Showdown & Свара
- Every player who hasn't folded reveals their cards and gets a score.
- For **each pot** (main, then side pots), find the best score among the players eligible for it:
  - If one player has it, they win that pot.
  - If two or more tie, the pot is **not paid out**. It goes into the **svara pot**, and the tied players
    become **svara participants**. If several pots tie, combine their tied players.
- If a svara happens:
  1. **Svara offer**: every other seated player with chips may **join** by paying
     `ceil(svaraPot / 2)`, rounded up to a multiple of the ante. They can only join if they can pay it in
     full. The human gets a prompt ("Влез в сварата за N" / "Откажи се"). Bots decide on their own.
  2. **Svara hand**: deal 3 new cards to the participants (fresh shuffled deck) with **no ante**. The svara pot
     is dead money that every participant can win, joiners included. Run a normal betting round, then
     a showdown. A svara can lead to another svara.
  3. Participants with 0 chips are all-in for the svara pot. If nobody can bet, go straight to showdown.
  4. The dealer button does not move during a svara.
- After a hand fully resolves, the dealer moves to the next seated player.
- **Chip conservation**: `sum(stacks) + pot` stays constant during a hand. Joining a svara only moves
  chips from a stack into the pot.

---

## 2. Code layout

```
index.html                 built standalone page (full document, for local open / GitHub Pages)
dist/svara-artifact.html   built artifact page (fragment: no doctype/html/head/body tags)
src/template.html          markup template with <!-- STYLES --> and <!-- SCRIPTS --> placeholders
src/styles.css
src/engine.js              rules, deck, scoring, game state machine (no DOM)
src/ai.js                  bot decisions + Monte Carlo equity (no DOM)
src/app.js                 UI: screens, rendering, animations, persistence
build.mjs                  node build.mjs → writes index.html and dist/svara-artifact.html
tests/engine.test.mjs      node --test
tests/ai.test.mjs          node --test
tests/e2e.mjs              Playwright playthrough (chromium at /opt/pw-browsers/chromium)
package.json               scripts: build, test, e2e ; devDependency playwright (no browser download)
```

- Plain JavaScript, no frameworks, no bundler. Each `src/*.js` is a **classic script** using a UMD
  wrapper: in the browser it sets a global (`SvaraEngine`, `SvaraAI`); in Node it sets `module.exports`.
  Tests load the modules with `createRequire`.
- `src/ai.js` reads `SvaraEngine` from the global in the browser and from `require('./engine.js')` in Node.
- `.gitignore`: `node_modules/`.

## 3. Engine API (`src/engine.js`) — the contract between engine and UI

```js
SvaraEngine.RANKS  // ['7','8','9','10','J','Q','K','A']
SvaraEngine.SUITS  // ['s','h','d','c']
// card: { rank: 'A', suit: 'h', id: 'Ah' }   (10 → rank '10', id '10h')
SvaraEngine.cardValue(card) -> number
SvaraEngine.isJoker(card, jokerWild = true) -> boolean
SvaraEngine.newDeck() -> card[32]
SvaraEngine.shuffle(deck, rng) -> deck            // Fisher–Yates, rng() in [0,1)
SvaraEngine.makeRng(seed) -> () => number         // mulberry32, for tests / reproducibility
SvaraEngine.scoreHand(cards, { jokerWild = true } = {}) ->
    { points, kind: 'three7'|'trips'|'aces'|'suit', label, usedCardIds: string[] }
    // usedCardIds = the cards that count toward the points (for showdown highlighting)
SvaraEngine.compareScores(a, b) -> number          // b.points - a.points style; 0 = tie

const game = SvaraEngine.createGame({
  players: [{ id, name, avatar, stack, isHuman }],   // seat order; index 0..5
  ante, bb, dealerIndex = 0, rng = Math.random, jokerWild = true,
})
game.startHand() -> Event[]          // posts antes, deals, sets toAct
game.getState() -> State             // deep-copied snapshot (safe to read)
game.legalActions(playerId) -> {
  canFold, canCheck, callAmount,     // callAmount = min(toCall, stack)
  canCall, canRaise, minRaiseTo, maxRaiseTo, canAllIn, allInAmount, isBet /* currentBet === 0 */
}
game.act(playerId, { type: 'fold'|'check'|'call'|'raise'|'allin', amount? /* raise-to total */ }) -> Event[]
game.svaraJoin(playerId, join: boolean) -> Event[]   // only in phase 'svara-offer'
game.nextHand() -> Event[]           // after phase 'hand-over': moves the button, starts a new hand
game.setPlayer(seatIndex, player | null)  // replace a busted bot / remove a seat (only between hands)
game.addChips(playerId, amount)      // rebuy (only between hands)
```

**State**:
```js
{
  phase: 'idle'|'betting'|'svara-offer'|'showdown'|'hand-over',
  handNumber, isSvara /* current deal is a svara replay */, svaraCount,
  dealerIndex, toAct /* playerId | null */,
  currentBet, minRaiseTo, ante, bb,
  pot /* total chips in the middle */, pots: [{ amount, eligible: [playerId] }],
  svaraPot, svaraParticipants: [playerId], svaraJoinCost, pendingSvaraDecisions: [playerId],
  players: [{ id, name, avatar, isHuman, seat, stack, roundBet /* chips put in this deal's betting */,
              committed /* total this deal incl. ante */, folded, allIn, inHand, sittingOut,
              cards /* always present in the engine state; the UI decides what to show */,
              lastAction /* {type, amount} | null */, score /* after showdown */ }],
  lastResult: null | { winners: [{ playerId, amount, potIndex }], svara: boolean,
                       scores: { [playerId]: score }, uncontested: boolean },
}
```

**Events** (returned in order, for the UI to animate):
`{type:'hand-start', handNumber, dealerIndex}`, `{type:'ante', playerId, amount}`,
`{type:'deal', playerId, count}`, `{type:'turn', playerId}`,
`{type:'action', playerId, action:{type, amount}, stack, roundBet}`,
`{type:'round-end', pot}`, `{type:'showdown', scores}`,
`{type:'win', playerId, amount, potIndex, uncontested}`,
`{type:'svara', participants, svaraPot, joinCost}`, `{type:'svara-join', playerId, paid}`,
`{type:'svara-decline', playerId}`, `{type:'svara-start', participants, pot}`,
`{type:'hand-over'}`.

The engine throws a clear `Error` on an illegal action, an action out of turn, or a wrong phase.

## 4. AI (`src/ai.js`)

```js
SvaraAI.equity(myCards, numOpponents, { iterations = 1200, rng, jokerWild = true } = {})
  -> { win, tie }        // Monte Carlo: random opponent hands from the remaining 29 cards;
                         // win = strictly best, tie = tied for best (→ svara)
SvaraAI.decide(state, botId, personality, rng) -> { type, amount? }   // always a legal action
SvaraAI.decideSvaraJoin(state, botId, personality, rng) -> boolean
SvaraAI.PERSONALITIES  // e.g. { rock, tag, lag, fish, maniac } : { tightness, aggression, bluff }
```
- Bots use **only their own cards** and public information (pot, bets, number of active players),
  never the human's cards or the deck.
- Decisions: compare equity against the number of active opponents to the pot odds, adjusted by
  personality and some randomness.
  - Raise sizes are 2.5–3× the current bet or 50–100% of the pot, rounded to `bb`.
  - Very strong hands (33/34) are sometimes slow-played. Weak hands are occasionally bluffed.
  - Bots must not be trivially exploitable: not always calling, not always folding.
- Svara join: weigh the expected share of the pot (`svaraPot / (participants + 1)`) against the cost,
  with randomness. Join only if the cost is ≤ 40% of the stack.

## 5. Screens & look (Bulgarian copy)

Visual reference: the recorded app. Pure **black** background, greys, thin outlined rounded buttons,
light-grey rounded cards, coral red for ♥♦, warm gold numbers in the bet bubbles and the win %, and 3D-emoji
avatars. Spacious and quiet. **The frames are a dimmed HDR→SDR conversion. Real colors are
brighter** (cards are near-white, text is white). It's a single dark look: `color-scheme: dark` on
`:root`, with an explicit background and every color set as a token.

Font: system stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif`)
to match the reference on iPhone. The big numbers use weight 200–300.

Layout: one phone-width column (max ~480px, centered on desktop), `height: 100%` (never `100vh`),
safe-area insets, a side gutter of `max(16px, env(safe-area-inset-left/right))`, and no horizontal
scroll. It must fit 375×667 up to 440×956 without page scrolling on the table screen.

### Home (`Начало`)
- Top row: XP badge (left) and a level ring (right).
- A huge thin bankroll number, `5 000`. Use bg-BG grouping with a narrow no-break space. It
  counts up or down when the bankroll changes (after leaving a table).
- A horizontal snap carousel of pastel gradient **mode cards** (emoji icon, title, subtitle):
  - **AI Арена** 🤖 "Играй срещу компютъра". Active; opens the stakes picker.
  - **Онлайн маси** 🌍 "Срещу истински хора · скоро". Locked (🔒); tapping shows the toast "Скоро".
- **Седмична класация**: medal, avatar, name and XP rows for the bot pool and the player ("Ти"), sorted
  by XP. Bot XP is fixed fictional numbers; the player's XP is real.
- Bottom nav (Shop · Home · Profile). Only Home is active; the others show the toast "Скоро".
- If the bankroll is below the smallest buy-in: a button **"Вземи 1 000 безплатни чипа"**.
- Starting bankroll: **5 000**.

### Stakes picker
- A back arrow, with the bankroll small at the top center.
- A grey gradient top panel showing `Залог` + a big `5 / 10`, `Вход` + a big `200 / 1 000` (coral when
  you can't afford the min buy-in), and the line `Анте 5 · Мин. залог 10`.
- A tick slider with 8 stops (tap or drag; the active tick is taller): 1/2, 5/10, 25/50, 50/100,
  250/500, 1K/2K, 5K/10K, 25K/50K. Buy-in range = `20×bb … 100×bb`. Large numbers are shortened as
  `1 хил.`/`1K` style; use `K`/`M` like the reference.
- A bottom button **ЗАПОЧНИ ИГРА**, disabled if you can't afford it. Buy-in = `min(maxBuyIn, bankroll)`
  (≥ min).

### Table
- **Top**: ← (leave) on the left, and the session XP `+6 XP` on the right.
- **Opponent row**: 5 seats. Each has an emoji avatar (~44px), a small grey name and a white stack
  number. The dealer gets a "D" badge. The player to act gets a small ▼ marker above the avatar, which pulses
  while the bot "thinks" (700–1300 ms). Folded seats are dimmed. The last action shows as a label over
  the avatar (`Пас`, `Чек`, `Плаща`, `Залага`, `Вдига`, `Ва банк`). Below each seat:
  - a dark bet bubble with a gold number
  - 3 tiny face-down cards while in the hand; at showdown they flip face up (mini rank+suit)
- **Middle**: a deck stack (striped back) and the **pot** (`Банка` + a big number). At showdown: a
  pill with the winning hand label (`Три дами`, `31 точки`). On a svara: a big **СВАРА!** banner with
  `Банка 1 200 · Влизане 600`.
- **Bottom**: the player's bet bubble, then the action row of outlined rounded buttons:
  - `[Пас] [Чек | Плащам 60] [Залагам 10 | Вдигам 150] [↑]`
  - When you can only go all-in: `[Пас] [Ва банк 560]`
  - The buttons are dimmed (not hidden) when it's not your turn. **↑** opens a raise sheet with a big amount,
    a slider from minRaiseTo to maxRaiseTo (step `bb`), presets `Мин · ½ банка · Банка · Ва банк`,
    and a confirm button `Вдигам до N`.
- **Your 3 cards**: big and overlapping, bottom left. Rank top-left, suit bottom-left, near-white face,
  coral for ♥♦, dark for ♠♣. 7♣ gets a subtle joker mark (★).
- **Info box**: an outlined box, bottom right, with the hand label on top (e.g. `21 точки`). Tap it to toggle
  between (avatar + stack) and (`Печалба 51%` / `Свара 6%`) computed with `SvaraAI.equity` against the
  active opponents. Small dots show which view is on.
- **After the hand**: a full-width **Следваща ръка** button replaces the action row.
- **Svara offer for the human**: a sheet "Свара! Влез за N?" with [Влизам] [Отказвам]. If the human
  is a participant, go straight on.
- **Leave sheet**: "Сигурен ли си?" / "Чиповете ти на масата ще се върнат в банката." with
  [Напусни масата] [Остани]. Leaving mid-hand folds you, and chips already committed are lost.
- **Busted**: a sheet "Свършиха ти чиповете" with [Купи отново N] (from the bankroll) [Към началото].
- **Busted bots** are replaced between hands by a new bot from the pool with a fresh buy-in (toast
  "Ива сяда на масата").
- **XP**: +1 per hand played, +5 per pot won.

### Animations (respect `prefers-reduced-motion`)
- Deal: cards fly from the deck to each seat; your cards flip face up.
- Bets: the bubble pops under the seat; at round end the chips slide to the pot and the pot counts up.
- Showdown: mini cards flip, losers dim, the winning cards and seat are highlighted, the pot flies to the
  winner, and the stack counts up.
- Svara: the banner scales in with a small shake.

### Bot pool (Bulgarian names + emoji)
Ива 🐭, Митко 😆, Гошо 🐼, Пешо 🧔, Сашо 😎, Нели 👩, Бобо 🐻, Тони 🦊, Деси 🐱, Краси 🤠,
Вальо 👨‍🦲, Мими 👵. Each has a personality.

### Persistence
`localStorage['svara.v1']` = `{ bankroll, xp, handsPlayed, handsWon, biggestPot }`. Wrap every
read and write in try/catch; the game works without storage. Hot reload hook:
`window.claude?.hot?.snapshot(() => profileWithTableStackReturned)` and boot via
`window.claude?.hot?.ready ? window.claude.hot.ready(start) : start(window.claude?.hot?.data ?? {})`.

## 6. Artifact page constraints (dist/svara-artifact.html)
- No `<!doctype>`, `<html>`, `<head>` or `<body>` tags. Start with `<title>Свара</title>` and
  `<meta name="claude:viewport-fit-sides" content="cover">`, then `<style>`, the markup and `<script>`s.
  Everything is inlined; no external requests (no CDNs needed).
- Keep the `:root` safe-area padding from the host skeleton. Use the side-gutter `max()` paddings
  on the outer wrapper.
- Never use `alert/confirm/prompt`. Every dialog is an in-page sheet.
- Visible keyboard focus; every form control gets a stable `id`.
- `index.html` (standalone) = the same content wrapped in a full document with
  `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.

## Reference video
`/tmp/claude-0/-home-user-testrepo/45e080a8-3aa6-5ddf-b173-73cd179b5b6b/scratchpad/video_dl/video.bin` (mp4, 68 s,
1320×2868, iPhone screen recording). The frames at 2 fps are in `.../scratchpad/frames/1fps/f_001.jpg` … `f_135.jpg`
(t = (n-1)/2 s). Contact sheets are in `.../scratchpad/frames/sheets/`. Home 0–20 s, stakes picker ~21 s,
table 22–64 s (deal, betting, all-in, showdown, leave sheet), home again 64–68 s.
