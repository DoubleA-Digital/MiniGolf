# Mini Golf

Nine procedurally generated mini golf holes that build from gentle to brutal.
Two players, one 4-letter room code, no backend.

**Play:** https://doublea-digital.github.io/MiniGolf/

Also listed on [CoolMattGames](https://coolmattgames.cool).

## How it works

Everything is one `index.html` — no build step, no framework, no server.
PeerJS handles the peer-to-peer link (same approach as
[Felt](https://github.com/DoubleA-Digital/Felt)).

**Multiplayer.** One player creates a room and shares the code; the other
joins. Both sides generate identical courses from a shared seed and simulate
every shot locally, so only the shot itself needs to cross the wire. After the
ball settles the shooter broadcasts its exact resting position, which means the
two views cannot drift apart even if the simulations diverge.

**Course generation.** A corridor is carved from tee to cup with random turns
and occasional room bulges, then obstacles and hazards are stamped in. Every
obstacle is applied speculatively and rolled back if it would seal the cup off,
so a generated hole is always completable. The tee and cup keep a guarded ring
around them, and bumpers stay clear of portals (a teleport lands the ball on a
cell centre, which would otherwise embed it inside one).

**Difficulty.** `DIFF_CURVE` sets a difficulty per hole, which drives corridor
width, hole length, block and bumper counts, hazard coverage and portal odds.
The curve eases in, spikes at hole 6, backs off, then builds to the hardest
finish. Par accounts for route length, clutter and tier.

**Rendering.** The static course art is pre-rendered once per hole into an
offscreen canvas, so per-frame work is limited to the things that actually
animate. That is what pays for the drop shadows, mown stripes and surface
texture.

## Tuning

The constants at the top of the script are the dials worth touching:

| Constant | Effect |
| --- | --- |
| `MAX_SPEED` | Launch speed at full power |
| `FRIC_GREEN` / `FRIC_ROUGH` / `FRIC_SAND` | Per-surface speed decay |
| `ROLL_DECEL` | Constant drag; higher makes the ball settle sooner |
| `REST` / `BUMPER_REST` | Wall and bumper bounciness |
| `HOLE_CATCH` / `HOLE_CENTER` | How fast a putt can be and still drop |
| `DIFF_CURVE` | Difficulty of each of the nine holes |
| `STROKE_LIMIT` | Strokes before a hole is picked up |

Difficulty was calibrated against a simulated player that aims at the furthest
visible point along the route and misses by a realistic margin. An exhaustive
solver is *not* a useful target here — it aces nearly every hole and makes par
look far too easy.

## Local development

```bash
python3 -m http.server 8077
# open http://localhost:8077
```

Open it in two browsers (or a phone on the same Wi-Fi) to test multiplayer.

## Known limitations

- PeerJS uses a public signalling broker. Fine for a game with a friend; not
  something to depend on for real traffic.
- Rooms are two players; a third connection is refused.
- There is no reconnect. If a peer drops, the game returns to the menu.
