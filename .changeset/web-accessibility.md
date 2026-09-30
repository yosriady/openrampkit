---
"@openrampkit/web": patch
---

Accessibility: WCAG AA text contrast in the light and dark palettes (muted text, success color), text on soft accent backgrounds uses the text color, and a custom accent becomes the focus ring only with 3:1 contrast. The dialog sets `lang`, keeps Tab inside itself (also where the browser skips buttons), handles Escape and Tab when focus is outside it, and returns focus to an opener that is still disabled at close. Results and "Copied" are announced in status regions. The amount field is marked invalid over the balance, with a text message tied to it. Form fields point at the step error. Touch targets are at least 44 px on phones, selects keep their size in WebKit, method subtitles wrap instead of being cut off, and a redirect without an SDK renderer is a real link. New strings: `overBalance`, `opensInNewTab`. New helper: `contrastRatio`.
