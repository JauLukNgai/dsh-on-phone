# DSH on Phone design system

## Direction

White background, restrained navy and cyan accents, compact developer-tool density, and a lively whale-girl character. The character may be expressive; the product UI remains calm and functional. Do not use gradients, glow, particles, glass effects, animated ambient backgrounds, or emoji icons.

## Color

| Role | Value |
| --- | --- |
| Background | `#FFFFFF` |
| Surface | `#F8FAFC` |
| Primary text | `#172554` |
| Secondary text | `#475569` |
| Accent | `#2563EB` |
| Accent soft | `#DBEAFE` |
| Border | `#BFDBFE` |
| Danger | `#DC2626` |

Maintain at least 4.5:1 text contrast. Dark mode follows DSH's own theme; plugin surfaces must not force a global theme.

## Typography

In product UI, inherit DSH's system font stack. README artwork contains no generated text. Use 16px inputs on mobile to avoid browser zoom and preserve user font scaling.

## Shape and depth

- Card radius: 16px.
- Button radius: 12px.
- Touch target: at least 44px; prefer 48px for primary mobile actions.
- Use a one-pixel blue-gray border and one restrained shadow at most.
- Never shift layout on hover or press.

## Motion

Use only short 150-200ms state transitions. Respect `prefers-reduced-motion`; no decorative entrance animation or continuous animation.

## Mobile layout

- Honor safe-area insets on every edge.
- Keep conversation content full-width on narrow screens.
- Prevent page-level horizontal overflow. Wide tables and code blocks may scroll inside their own containers.
- Keep primary actions reachable above the soft keyboard.
- Test 375px and 390px portrait, landscape, font scaling, and keyboard-open states.

## Imagery

The repository ships no generated brand artwork: the icon master and hero canvas were dropped in `73a4edb`, and nothing references them. The only images in the tree are the four real phone screenshots under `assets/screenshots/` that the READMEs embed — keep those captured from a real device rather than mocked up, and do not reintroduce rendered mascot or icon masters.

## Review checklist

Walk this list against every change that touches the phone surfaces:

- [ ] White background and restrained accents.
- [ ] No emoji icons, gradients, glow, particles, or glass effects.
- [ ] Visible keyboard focus.
- [ ] 44px minimum touch targets.
- [ ] Safe-area and soft-keyboard handling.
- [ ] Reduced motion supported.
- [ ] No content hidden behind fixed controls.
- [ ] No page-level horizontal overflow at 375px; wide content scrolls only inside its container.
