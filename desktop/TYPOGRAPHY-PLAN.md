# Typography plan: readable, clear, actionable

Status: implemented with the shared Text component in the app and Storybook.
Date: September 25, 2026.
Scope: the board and existing shared components, reviewed in Storybook first.

## Direction

**A working interface, not a landing page.**
The goal is to distinguish what to read, what to act on, and what organizes the work.
Typography should support the monochrome brand through clarity rather than decoration.

Use Vercel's distinction between copy, labels, buttons, and headings as a reference [1].
Use Notion as a content-first visual reference, not as a claim about its exact font
or internal design tokens. We are defining our own small system.

Success should look quiet: readable titles, obvious actions, compact tables,
and headings that organize rather than dominate.
These are usability goals, not a claim that a particular font guarantees productivity.

## Font decision

**Geist Sans**, with a metric-adjusted Arial fallback followed by the system stack.
It gives us a direct connection to the restrained Vercel reference; Geist's own
design direction emphasizes simplicity and clarity [2].
Use one sans-serif family, not different fonts for headings, controls, and content.

The implemented family stack is:

```css
--font-sans: "Geist Sans", "Geist Fallback", ui-sans-serif, system-ui, -apple-system,
  BlinkMacSystemFont, "Segoe UI", sans-serif;
```

The implementation must use the actual registered font-family name, or the font
loader's generated CSS variable, rather than assuming the asset's internal name.
No Geist Mono download, serif option, condensed face, or decorative display font.
If code-like identifiers are introduced later, use the system monospace stack.

This is the approved revision to THEME-PLAN.md's original system-font-only rule.
The theme specification and CSS tokens now use the same family and three weights.

## Three weights, three jobs

| Weight | Meaning | Use |
| --- | --- | --- |
| `400` regular | Read this | Descriptions, archive rows, status values, empty-state explanations |
| `500` medium | Act on this | Task titles on draggable cards, button labels, concise interactive labels |
| `600` semibold | Organize this | Board column headings, accordion titles, section headings |

Do not make every component semibold. That would remove the hierarchy we are creating.
Avoid weights below 400 for essential UI text and avoid 700+ in the current board.
Use the same weight for a role in light and dark mode; do not thin dark-mode text.
Use real font weights, not text shadows, synthetic bold, or browser smoothing overrides.

## Small type scale

Most of this product should stay at **14px**. Weight, spacing, and placement do
more work than size. Use `rem`; pixel equivalents assume the user's default 16px root.

| Size | Line height | Use |
| --- | --- | --- |
| `12px` / `0.75rem` | `1.5` / 18px | Counts and genuinely supplementary metadata only |
| `14px` / `0.875rem` | `1.5` / 21px | Cards, buttons, rows, headings, labels, and instructions |
| `16px` / `1rem` | `1.5` / 24px | Longer reading content if that surface is later introduced |
| `20px` / `1.25rem` | `1.25` / 25px | A future page title, not a new title above the board |

Do not add larger text simply to make the UI feel expensive.
The 16px and 20px roles are reserved; do not add unused components or visible headings.
Do not shrink labels when space is tight. Allow wrapping or scrolling instead.

## Typography tokens

Keep the existing token names where possible; avoid duplicate tokens for the same value.

| Token | Value | Change |
| --- | --- | --- |
| `--font-sans` | Geist Sans, Geist Fallback, then system fonts | Implemented |
| `--font-size-body` | `0.875rem` | Keep |
| `--font-size-meta` | `0.75rem` | Keep |
| `--line-height` | `1.5` | Keep |
| `--font-weight-normal` | `400` | Keep |
| `--font-weight-medium` | `500` | Implemented |
| `--font-weight-strong` | `600` | Keep |
| `--font-size-reading` | `1rem` | Add only when a reading surface exists |
| `--font-size-title` | `1.25rem` | Add only when a page-title surface exists |
| `--line-height-heading` | `1.25` | Add with the larger title role |

Use normal letter spacing for all current components. No tracked uppercase labels.
If the future 20px title needs optical tightening, cap it at `-0.015em`; review it
at normal size rather than applying negative tracking to small text.
Use sentence case: "In progress", not "IN PROGRESS".

## Map the roles to our components

| Element | Size / weight | Color token and behavior |
| --- | --- | --- |
| Board column heading | 14 / 600 | `--color-text`; same treatment for every status |
| Draggable work-item title | 14 / 500 | `--color-text`; wrap naturally; full card remains draggable |
| Generic Card content | 14 / 400 | Inherit body role; do not force all card content to 500 |
| Primary Button label | 14 / 500 | `--color-on-action`; primary fill provides emphasis |
| Secondary Button label | 14 / 500 | `--color-text`; identical metrics to the primary variant |
| Accordion title | 14 / 600 | `--color-text`; preserve its 40px full-row target |
| Accordion/archive count | 12 / 500 | `--color-text-secondary`; separate span, retained in accessible name |
| List column heading | 12 / 500 | `--color-text-muted`; quiet metadata, title case; sort buttons keep 40px targets |
| Archive item title | 14 / 400 | `--color-text`; reading content, not a pretend button |
| Archive status value | 14 / 400 | `--color-text-secondary`; no colored status typography |
| Empty-state explanation | 14 / 400 | `--color-text-muted`; instructions must remain readable |

Use `Text` variants `body` (default), `action`, `heading`, and `meta` for these roles.
Its CSS Module owns typography; component CSS Modules retain layout and interaction styles.
`asChild` uses Radix Slot to preserve native elements and refs without extra wrappers.
Color inherits by default, including primary/disabled button text. Optional `tone`
is `secondary` or `muted`; `tabular` opts numbers into fixed-width digits.
The Accordion title explicitly uses `heading` inside the action-styled Button.
Card/List/Accordion content inherits body; ListCell uses medium primary text when paired with secondary metadata.

## Action hierarchy

The existing Button now supports a primary brand variant independently of this plan:
near-black fill with light text in light mode, near-white fill with dark text in dark mode.
Primary and secondary labels should have the same size and weight; fill establishes priority.
Prefer one primary action per local decision area when such actions are introduced.
Use specific verb-led labels; a type style cannot fix vague action copy.
Do not add new actions, toolbars, forms, or board controls as part of typography work.

## Reading, wrapping, and numbers

- Let task titles and long headings wrap; do not default to line clamping or ellipsis.
- Keep line height unitless and containers content-sized so zoom does not clip text.
- Use `overflow-wrap: anywhere` only as a fallback for unbroken strings.
- Keep text left-aligned; align actual numeric columns right if they are introduced.
- Scope `font-variant-numeric: tabular-nums` to counts and numeric columns, not all copy.
- For future prose, start with a 60-72ch reading measure; do not impose that on board cards.
- Use semantic headings, labels, buttons, and table headers; visual size does not define semantics.

## Performance and font delivery

One roman variable WOFF2 supports real 400-600 weights: **47,740 bytes (46.6 KiB)**,
below the **60 KiB** budget. No runtime font dependency or third-party requests.
`src/app/fonts.css` serves the same `/fonts/geist-sans-1.7.2-400-600.woff2` file
in Next.js and Storybook, using `font-display: swap` without invisible-text gates.
The original SIL OFL notice is retained in `public/fonts/LICENSE-Geist.txt`.

Source: official `geist@1.7.2`, `dist/fonts/geist-sans/Geist-Variable.ttf`.
Generation used isolated `subset-font@2.7.0` and `fontkit@2.0.4` tooling, not app dependencies:

```js
const original = fontkit.create(sourceBuffer);
const result = await subsetFont(sourceBuffer, String.fromCodePoint(...original.characterSet), {
  targetFormat: "woff2", variationAxes: { wght: { min: 400, max: 600, default: 400 } },
  preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 13, 14],
});
```

All original mapped characters are retained (729 cmap entries, including the pre-existing
U+FFFF missing-glyph sentinel); glyph availability was compared with the original.
Scripts outside the original coverage still use installed system fonts.
Output SHA-256: `22eaa7ce5601c2295655b9f7a0fa6e14fba534610561319c3c4c19d19219d7a0`.
Font variation data and layout features are retained rather than synthesizing weights.

Fallback faces use local Arial (400/500) and Arial Bold (600). Width ratios were measured
at each weight against this sample, then ascent/descent were divided by the size adjustment:
`abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 Plan next release Review requirements Archive Completed`.
The resulting `size-adjust` values are 100.9593%, 103.2912%, and 100.2497%.
These reduce shifts, not guarantee identical wrapping for arbitrary text or missing Arial.
Browser checks cover delayed/failed fonts and cold/warm loading on Windows Chromium.
macOS rendering remains a manual cross-platform check; it is not verified on this host.

The Text specimen in Storybook shows all four roles, ambiguous glyphs, accented names,
fallback scripts, tabular dates/counts, both Button variants, Card, Accordion, and List.
No new page headings, controls, 16px/20px tokens, or app theme preferences were introduced.

## Acceptance criteria

- Titles, actions, headings, and supporting text are distinguishable without color.
- Every normal-size text role meets the theme's 4.5:1 contrast requirement.
- No lost content at 200% text resizing or in narrow board/list layouts.
- User spacing overrides do not clip content: 1.5 line height, 2em paragraph spacing,
  0.12em letter spacing, and 0.16em word spacing [5].
- Font failure leaves readable system text; font arrival does not move a focused control
  or materially change the board's wrapping. Review cold cache as well as warm cache.
- Verify representative Windows and macOS rendering; do not assume identical rasterization.
- Preserve keyboard labels, focus rings, full-card dragging, and reduced-motion behavior.
- Each handwritten file remains under 200 lines; this is typography, not an app redesign.

## References

[1] Geist typography roles: `https://vercel.com/geist/typography`
[2] Geist font: `https://vercel.com/font`
[3] Notion content styling reference: `https://www.notion.com/help/customize-and-style-your-content`
[4] Next.js font loading: `https://nextjs.org/docs/app/getting-started/fonts`
[5] W3C text-spacing requirements: `https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html`
