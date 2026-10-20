# Свара — AI Арена

The Bulgarian card game **Свара** in the browser: you against 5 computer players. The UI is in Bulgarian and the
look follows a minimal black poker app.

## Play

Open `index.html` in a browser. It is one self-contained file with no network requests.

## Rules (standard Svara)

- 32 cards (7 to Ace), 3 cards each. A = 11, 10/J/Q/K = 10, 7–9 = face value.
- Cards of the same suit add up. The **7♣ is wild**: it counts 11 and fits any suit.
- Two aces = 22. Three of a kind = their sum (three aces = 33). **Three 7s = 34**, the best hand.
- Each hand has one round of no-limit betting after an ante.
- A tie for the pot is a **свара**: the tied players play again for it. Other players can join by
  paying half the pot.

The full spec is in `docs/SPEC.md`.

## Develop

```sh
npm install        # dev dependency: playwright (uses the preinstalled Chromium)
npm test           # engine + AI unit tests (node --test)
npm run build      # src/ → index.html and dist/svara-artifact.html
npm run e2e        # Playwright playthrough on phone-sized screens
```

| File | What it does |
|---|---|
| `src/engine.js` | rules, scoring, betting, side pots, svara (no DOM) |
| `src/ai.js` | computer players: Monte Carlo equity + personalities |
| `src/app.js`, `src/styles.css`, `src/template.html` | screens, table, animations |
| `build.mjs` | inlines everything into the two built pages |
