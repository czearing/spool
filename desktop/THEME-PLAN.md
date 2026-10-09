# Theme plan: quiet, precise, productive

Status: tokens implemented; theme selection is wired into Storybook only.
Date: September 28, 2026.
Scope: light/dark previews for the existing board and shared components.

## Brand direction

Our proposed brand promise is **clarity without distraction**.
The product should feel like a dependable work surface, not a marketing page.

Use Vercel-like precision and the content-first feeling we associate with Notion
as references, not as palettes to copy. Geist's separation of backgrounds,
interaction states, borders, and text is a useful structural reference [1].
Notion's System/Light/Dark preference is a useful behavior reference [2].
The exact values below are our proposal, not either company's official tokens.

## Why this should feel productive

- **Work gets the contrast.** Titles and actionable content are stronger than dividers.
- **Less visual competition.** Semantic group labels use restrained color; controls stay neutral.
- **Predictable hierarchy.** Position, spacing, type weight, and labels communicate importance.
- **Two modes, one product.** Switching themes changes luminance, not layout or meaning.
- **Visible affordances.** Readable secondary text and clear focus states take priority over faint aesthetics.
- **Restraint feels deliberate.** Consistent surfaces and small radii replace decoration.

These are design goals, not measured productivity claims; validate both themes with users.

## Palette rules

Use true neutral grays for controls and base surfaces.
No purple, blue-tinted charcoal, gradients, or glass effects.
Light mode uses a white canvas and ink-like text. Dark mode uses a near-black
canvas with slightly lighter cards, so hierarchy does not depend on shadows.
Near-white dark-mode text avoids using pure white for every label.

Do not mechanically invert the page. Each semantic role has a deliberate value.
Keep ordinary controls neutral; reserve filled black/white treatment for a primary
action when the product needs one. The board's New action is neutral, never brand-colored.

## Color tokens

Component CSS Modules consume these semantic custom properties directly.
This small palette does not need a second, unused 50-950 primitive scale.

| Token | Light | Dark | Intended use |
| --- | --- | --- | --- |
| `--color-canvas` | `#FFFFFF` | `#0A0A0A` | Page and board background |
| `--color-surface` | `#FFFFFF` | `#141414` | Cards and neutral buttons |
| `--color-surface-subtle` | `#F5F5F5` | `#1C1C1C` | Optional grouped content, not every column |
| `--color-surface-hover` | `#F5F5F5` | `#242424` | Hovered interactive surfaces |
| `--color-surface-pressed` | `#EDEDED` | `#2E2E2E` | Pressed surfaces and selected rows |
| `--color-text` | `#171717` | `#EDEDED` | Titles, body text, headings |
| `--color-text-secondary` | `#525252` | `#B3B3B3` | Supporting descriptions and status values |
| `--color-text-muted` | `#666666` | `#A1A1A1` | Metadata and empty-state text |
| `--color-border-subtle` | `#E5E5E5` | `#2B2B2B` | Decorative table separators only |
| `--color-border-control` | `#858585` | `#7A7A7A` | Necessary button/card/drop-zone boundaries |
| `--color-border-hover` | `#171717` | `#EDEDED` | Hover emphasis on interactive boundaries |
| `--color-focus-ring` | `#171717` | `#EDEDED` | Keyboard focus and active drop outlines |
| `--color-action` | `#171717` | `#EDEDED` | Optional filled primary action |
| `--color-action-hover` | `#333333` | `#D4D4D4` | Filled-action hover |
| `--color-action-pressed` | `#404040` | `#BDBDBD` | Filled-action press |
| `--color-on-action` | `#FFFFFF` | `#0A0A0A` | Text on filled actions only |
| `--color-disabled-surface` | `#F5F5F5` | `#1C1C1C` | Inactive controls |
| `--color-disabled-text` | `#737373` | `#777777` | Inactive control labels only |
| `--color-selection` | `#171717` | `#EDEDED` | Native text-selection background |
| `--color-on-selection` | `#FFFFFF` | `#0A0A0A` | Native selected text |

Subtle borders are intentionally quiet; they must not be the sole indicator of
an interactive control or an important state. Use `border-control` where the
boundary is needed to recognize the control. Its stronger contrast is deliberate.
The three text tokens are valid on all five neutral background/state tokens.
Use `on-action`, not ordinary text tokens, on filled actions.

## Shared geometry and typography

These values do not change between themes. No theme-specific density changes.

| Token | Implemented value | Reason |
| --- | --- | --- |
| `--font-sans` | `"Geist Sans", "Geist Fallback", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | Shared local font and metric-adjusted fallback |
| `--font-size-body` | `0.875rem` | 14px at the default root size; readable compact rows |
| `--font-size-meta` | `0.75rem` | 12px metadata; never substitute for essential instructions |
| `--line-height` | `1.5` | Room for scanning and wrapped titles |
| `--font-weight-normal` / `--font-weight-medium` / `--font-weight-strong` | `400` / `500` / `600` | Read / act / organize |
| `--space-1` / `--space-2` / `--space-3` | `4px` / `8px` / `12px` | Compact internal rhythm |
| `--space-4` / `--space-6` | `16px` / `24px` | Component padding and board margin |
| `--space-0` / `--space-8` | `0px` / `32px` | No gap / maximum page padding |
| `--space-page` | `clamp(var(--space-4), 3vw, var(--space-8))` | Responsive 16-32px page padding |
| `--radius-control` | `6px` | Preserve the existing restrained shape |
| `--border-width` | `1px` | Thin, consistent boundaries |
| `--focus-width` / `--focus-offset` | `2px` / `3px` | Clear external keyboard outline |
| `--duration-fast` | `120ms` | Short feedback and floating-surface fades; zero with reduced motion |
| `--duration-disclosure` / `--ease-disclosure` | `180ms` / `cubic-bezier(.2, .8, .2, 1)` | Accordion height and chevron motion; disabled with reduced motion |

The root font size remains user-controlled. Body text uses 14px Geist Sans;
both modes share the same typography and are available for review in Storybook.
Toolbar controls stay flat. Board cards use shared hairline elevation; no theme-transition animation.
The requested accordion disclosure is the only layout animation; it uses Radix's measured height.
TYPOGRAPHY-PLAN.md documents the implemented Text roles, local font, and fallback.
Spacing lives in `src/app/spacing.css`, imported by the theme. Stack and Grid
consume the same typed spacing keys; the board uses 16px column and 24px section gaps.
`ui-tokens.css` adds control/icon/avatar sizes, constrained overlay widths, layers,
and a neutral backdrop. `elevation.css` owns hairline and three floating shadow tiers, semantic
surface mappings, and toast gutters; README records the tokens. Forced colors removes shadows.
Inputs, menus, dialogs, pivots, notifications, and tooltips reuse the existing text,
surface, border, and focus palette; errors use explicit copy, not a colored accent.

## Component mapping

| Surface | Application |
| --- | --- |
| Board | Four softly tinted Grid columns, aligned status icons/labels/counts, and a compact neutral control strip |
| Card | Board cards use `surface`, `text`, `border-subtle`, and shared hairline elevation; hover/focus adds contrast |
| Button | Neutral surface/control border by default; optional filled action uses the action pair |
| List | Neutral surface; subtle 1px dividers flush with the header row; focus emphasizes lines/labels using existing tokens, not button boxes |
| Accordion | Inherits its container; text-colored trigger; no special expanded-state color |
| Archive | Inherits canvas; quiet top separator; collapsed with count; the entire region accepts drops |
| Valid drop | Hover surface plus a 2px focus-colored outline; preserve live announcements |
| Errors/statuses | Explicit labels and explanations; never communicate success or failure through color alone |

Backlog stays neutral; In progress uses info, Completed success, and Blocked danger.
Use selected-row treatment only if selection is later introduced; no new selection feature now.
Replace blanket disabled opacity with the disabled tokens; do not fade whole containers.
Keep the dragged preview fully readable; an origin placeholder can remain faded.

## Contrast requirements

Target at least 4.5:1 for ordinary text [3] and 3:1 for required control/state
indicators against adjacent colors [4]. Do not use the large-text exception for
small board labels. Disabled controls are exempt, but important instructions are not.

Calculated using the WCAG sRGB relative-luminance formula. Minimums below cover
all five specified neutral backgrounds, including hover and pressed states.
Display values are rounded; pass/fail uses the unrounded ratio.

| Pair | Light minimum | Dark minimum |
| --- | --- | --- |
| Primary text / neutral backgrounds | 15.31:1 | 11.60:1 |
| Secondary text / neutral backgrounds | 6.67:1 | 6.48:1 |
| Muted text / neutral backgrounds | 4.90:1 | 5.26:1 |
| Control boundary / neutral backgrounds | 3.15:1 | 3.16:1 |
| On-action text / all three action backgrounds | 10.37:1 | 10.54:1 |

Focus rings use primary-text contrast on neutral surroundings. For filled controls,
keep the outline outside the control with its offset; do not rely on an inset ring
that matches the button fill. Native text selection uses the high-contrast action pair.
Token ratios alone do not establish full WCAG compliance; test actual rendered states.

## Implementation

1. `src/app/theme.css` defines each token once using native `light-dark()` [5].
   Explicit `html[data-theme="light"]` / `[data-theme="dark"]` selects `color-scheme`.
2. `html[data-theme="system"]` follows the OS through `color-scheme: light dark`.
   With no theme attribute, the app remains light; no app preference logic is installed.
3. Storybook's built-in Theme control owns the selected preview mode.
   A small decorator updates the root attribute before the story paints.
4. There is no custom theme toolbar, storage, app bootstrap, or hydration suppression.
   Application theme integration is deferred until explicitly requested.
5. Component CSS Modules use semantic tokens; layout rules remain local.
   Radix portals inherit document-level tokens; forced-colors mode uses system colors.
6. Storybook's System/Light/Dark toolbar changes only the preview's root theme.
   It does not persist app preferences, remount the board, or reset query/accordion state.

App theme controls and persistence remain out of scope; Storybook owns theme selection.

## Acceptance criteria

- Both themes cover the board, every shared component, portaled overlays, focus, and dragging.
- Keyboard focus, collapsed-archive drops, disabled controls, and empty states remain clear.
- Preview appearance and live OS changes in System mode are verified without remounting.
- Check text and required boundaries in rest/hover/pressed states, not just a palette screenshot.
- Run automated accessibility checks plus keyboard, touch, forced-colors, reduced-motion,
  and 200% zoom checks. Preserve native focus behavior in high-contrast modes.
- No decorative accents, layout jumps on theme change, or contrast loss in secondary text.
- Keep every handwritten file under 200 lines; use existing tests and CSS Modules.

## Board semantic extension

`semantic-colors.css` owns meaning-bearing `--color-{info,success,warning,danger}-{text,surface}` tokens:

| Meaning | Light text / surface | Dark text / surface |
| --- | --- | --- |
| Info / active work | `#315F85` / `#E9F0F6` | `#A3BDD3` / `#202C38` |
| Success / completed | `#3E654B` / `#EDF3ED` | `#ABC7B0` / `#243127` |
| Warning (reserved; not shown on the board) | `#92400E` / `#FFFBEB` | `#FCD34D` / `#2C2414` |
| Danger / blocked | `#92504B` / `#F8EDEB` | `#D9AAA4` / `#382826` |

Status text and icons carry meaning. Column tokens mix semantic surfaces at 40% with the canvas (neutral: 65%).
Each pair meets 4.5:1 text contrast; forced colors uses CanvasText/Canvas.
Board tokens set 16rem column widths, 14rem minimum height, 2rem controls, and 12rem search; dots are .375rem.

## References

[1] Vercel Geist color roles: `https://vercel.com/geist/colors`
[2] Notion appearance preferences: `https://www.notion.com/help/account-settings`
[3] W3C text contrast: `https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html`
[4] W3C non-text contrast: `https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html`
[5] Native theme pairs (modern browsers): `https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark`
