# DarkCode Desktop — design system

The visual language follows [vufh.dev](https://www.vufh.dev/). Tokens live in
`src/theme.h` and nothing in `src/ui.cpp` picks a colour or a size of its own.

## Ground rules

1. **Pure black ground.** `#000000`, not dark grey, so everything above it reads
   as a light source rather than a lighter box.
2. **Surfaces are translucent white.** A panel is the ground plus 3.5% white;
   its edge is the ground plus 9%. One neutral ramp, no hue in the chrome.
3. **No accent colour.** Primary is the inversion — white ground, black label —
   and there is exactly one on screen at a time. The only colour is a seven-stop
   spectrum, spent on the mark and the working indicator.
4. **Small, quiet type.** 15px body, weight 300 for anything set large.

## Palette

| Token | Value | Use |
|---|---|---|
| `kCanvas` | `#000000` | window ground |
| `kSurfaceFaint` | white 2% | resting tool cards, chips |
| `kSurface` | white 3.5% | panels, inputs, secondary buttons |
| `kSurfaceHover` | white 6% | hover |
| `kSurfaceActive` | white 9% | pressed, selected |
| `kBorder` | white 9% | every hairline |
| `kBorderStrong` | white 16% | emphasis edges |
| `kText` | `#f5f5f5` | body |
| `kTextSoft` | `#cfcfcf` | large quiet text |
| `kTextMuted` | `#8a8a8a` | secondary |
| `kTextFaint` | `#5c5c5c` | tertiary, metadata |
| `kAccent` / `kOnAccent` | `#f5f5f5` / `#000` | the one inverted primary |
| `kDanger` / `kWarning` / `kSuccess` / `kInfo` | `#ff4d4d` `#ffa64d` `#4dff88` `#4dd2ff` | taken from the spectrum's own stops |

**Contrast.** `kText` on `kCanvas` is 19.2:1. `kTextMuted` is 6.6:1 — fine for
body. `kTextFaint` is 3.1:1, which clears the large-text bar but not the 4.5:1
body bar, so it is restricted to metadata that repeats elsewhere (timings, token
counts, the status line) and never carries information available nowhere else.

## Type

Inter for everything, JetBrains Mono for code, paths and tool arguments — a
sans/mono pairing, not two sans-serifs. Both ship in `assets/fonts/` (SIL OFL)
and fall back to Segoe UI / Cascadia Mono when the folder is absent.

| Role | Face | Size |
|---|---|---|
| `display` | Inter SemiBold | 16.5 |
| `heading` | Inter SemiBold | 15 |
| `medium` | Inter SemiBold | 13 |
| `body` | Inter Regular | 15 |
| `caption` | Inter Regular | 12.5 |
| `light` | Inter Light | 19 (large quiet text only) |
| `mono` | JetBrains Mono | 12 |

Ratio between steps is ~1.15. Glyph coverage is extended past Latin-1 to include
general punctuation, arrows and box drawing, because that is what a model writes
and what `webFetch` decodes out of a page.

## Motion

Product motion: **state, not decoration**. 140–200ms, exponential ease-out, no
bounce. There is deliberately **no entrance choreography** — the app opens into
a task and nobody wants to watch it load.

What animates, and why:

| Element | Conveys |
|---|---|
| Window controls | hover / press affordance |
| Session rows | hover and selection |
| Composer focus ring | keyboard focus |
| Working track | the turn is alive |
| Tool disclosure | expanded state |

`prefers-reduced-motion` has a Windows equivalent: `SPI_GETCLIENTAREAANIMATION`.
When the user has turned system animations off, every duration collapses to zero
and states snap. This is checked at startup and on `WM_SETTINGCHANGE`.

## Window

Frameless. The OS title bar is removed with `WM_NCCALCSIZE`; resize edges, snap,
Aero shadow and double-click-to-maximise are preserved through `WM_NCHITTEST`
and a one-pixel DWM frame extension. The app draws its own 38px title strip with
the mark on the left, a drag region across the middle, and minimise / maximise /
close on the right.

Rationale: the OS caption is a light-grey bar on a pure-black app, and it is the
one surface the palette cannot reach.
