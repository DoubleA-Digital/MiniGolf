# Mini Golf

Nine procedurally generated mini golf holes that build from gentle to brutal.
Tournaments for any number of players, one 4-letter room code, everyone putts
at once. Profiles, cosmetic balls and points are backed by Supabase.

**Play:** https://doublea-digital.github.io/MiniGolf/

Also listed on [CoolMattGames](https://coolmattgames.cool).

## How it works

Everything is one `index.html` — no build step, no framework, no server.
PeerJS handles the peer-to-peer link (same approach as
[Felt](https://github.com/DoubleA-Digital/Felt)).

**Multiplayer.** The host opens a room and shares the code; everyone else
joins and appears in the lobby. Connections form a star: guests talk to the
host, and the host relays each message on to the rest. Every client generates
identical courses from a shared seed and simulates all balls locally, so only
the shot crosses the wire. The owner of a ball is the only authority on where
it stopped and what it scored, and broadcasts that when it settles — the other
clients snap to it rather than trusting their own replay.

Players putt **simultaneously** rather than in turn, which is what makes a
large field playable; the only thing gating your shot is your own ball being at
rest. The host decides when a hole is over and tells everyone to advance, so a
client that is mid-replay (or backgrounded, where the browser pauses its
animation) still moves on with the group.

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

## Profiles, points and cosmetics

Profiles live in Supabase (project `esogrnjilzxcmvgpieib`). `mg_profiles` is
RLS-locked with **no policies at all** — anon can neither read nor write it
directly. Everything goes through `SECURITY DEFINER` functions that check a
per-profile token and clamp the inputs:

| Function | Purpose |
| --- | --- |
| `mg_create_profile` | First run; stores a SHA-256 of the client's token |
| `mg_get_profile` | Reads your own row, token required |
| `mg_save_profile` | Name, avatar, uploaded picture, equipped ball |
| `mg_unlock_ball` | Spends points; refuses if you cannot afford it |
| `mg_award_points` | End of tournament; clamped to 400 per call |
| `mg_leaderboard` | Public top 25 |

Points: **25 for taking part, up to 100 for placement, 8 per hole under par.**
The ball catalogue (`mg_balls`) is the server-side authority on cost, so the
client cannot grant itself a ball by editing prices. Points are still *reported*
by the client, which a determined player could inflate — acceptable for a
friends' game, and the reason every award is clamped.

Uploaded profile pictures are cropped square and scaled to 96px JPEG before
being stored, keeping a row a few KB rather than a few MB.

The identity lives in `localStorage`, so clearing site data starts a new
profile. The leaderboard is shared; the identity is not portable across devices.

## Playing

- **Drag anywhere** to aim and pull back; release to putt. Hold **shift** while
  dragging for fine aim on a long putt.
- Once your ball is in the hole, **drag to look around** and the camera follows
  whoever is still playing. The offset eases away as soon as it's your shot
  again, so you never aim from an off-centre camera.
- Players who are off-screen show as **edge markers** with their initial and
  distance — with a big field and the camera on your own ball, they would
  otherwise be invisible.
- The roster shows each player's **running total against par**, so the
  standings are readable mid-round without opening the scorecard.
- **Invite link:** the host's `Copy invite link` button produces a
  `?room=CODE` URL that drops someone straight into the join screen with the
  code filled in.
- **Play Again** at the end keeps the same room and field — a tournament group
  never has to re-share a code between rounds.
- Sound can be muted (remembered), and `prefers-reduced-motion` disables
  confetti and ball trails.

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

## If nobody can join

Hosting and joining need a **signalling server** to introduce the peers. The
default is the free PeerJS cloud at `peerjs.com`, and some networks block it
outright — school and office Wi-Fi especially. The symptom is specific: DNS
resolves, TCP connects on 443, and then the TLS handshake is reset.

Check it from a terminal:

```bash
curl -sv -m 10 https://0.peerjs.com/peerjs/id 2>&1 | grep -E "Connected|reset|error"
```

If that fails while other sites work, the network is the problem, not the game.
The menu runs the same check on load and says so before anyone tries to host.

Two ways around it:

1. **Use mobile data or a hotspot** — quickest test, and usually enough.
2. **Run your own PeerServer** and point the game at it:
   `?peer=your-host:443/path`, or paste it into the box on the warning banner.
   It is remembered. A server is `npx peerjs --port 9000 --path /mg`, deployed
   anywhere that supports WebSockets (Railway, Fly, Render — not Vercel
   serverless).

## Known limitations

- The default PeerJS cloud broker is free and public. Fine for a game with
  friends; not something to depend on for real traffic, and blocked on some
  networks (see above).
- Joining is closed once the host starts; there is no late join.
- There is no reconnect. If a guest drops they are marked out for the round;
  if the host drops, the room ends.
- Every message is relayed by the host, so the host's connection is the
  bottleneck for a very large field.
- Points are client-reported and clamped server-side, not verified.
