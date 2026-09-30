// Accessibility checks with axe-core. AxeBuilder scans into the modal's Shadow DOM.
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/**
 * Run axe on `<openramp-modal>` and fail on serious or critical violations.
 * `screen` names the screen in the failure message.
 */
export async function expectAccessible(page: Page, screen: string) {
  // Let entry animations finish, so axe reads the final colors.
  await page.waitForTimeout(250)
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
