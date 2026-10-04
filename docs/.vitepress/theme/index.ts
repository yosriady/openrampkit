import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import DemoEmbed from './DemoEmbed.vue'

// The default theme, plus the live demo right under the hero on the home page.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-after': () => h(DemoEmbed) }),
}
