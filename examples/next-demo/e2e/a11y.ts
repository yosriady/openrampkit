// Accessibility checks with axe-core. AxeBuilder scans into the modal's Shadow DOM.
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/**
 * Run axe on `<openramp-modal>` and fail on serious or critical violations.
 * `screen` names the screen in the failure message.
 */
export async function expectAccessible(page: Page, screen: string) {
  await animationsDone(page)
  const results = await new AxeBuilder({ page }).include('openramp-modal').withTags(TAGS).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const report = blocking.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    targets: v.nodes.map((n) => n.target.join(' > ')).slice(0, 5),
    summary: v.nodes[0]?.failureSummary,
  }))
  expect(report, `axe violations on the "${screen}" screen`).toEqual([])
}

/**
 * Wait until the modal's entry animations and color transitions (theme change, a button that
 * turns enabled) end, so axe reads the final colors. A fixed wait is not enough: on a busy machine
 * WebKit can start a 120 ms transition late, and axe then reads the color from before the change.
 * Spinners and skeletons repeat forever, so they are skipped.
 */
async function animationsDone(page: Page) {
  await page.evaluate(async () => {
    const root = document.querySelector('openramp-modal')?.shadowRoot
    if (!root) return
    // Two frames: let a theme or state change that is still pending start its transitions.
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame)
    const finite = root.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
    await Promise.all(finite.map((a) => a.finished.catch(() => {})))
  })
}
