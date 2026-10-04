<script setup lang="ts">
import { withBase } from 'vitepress'
</script>

<template>
  <section class="demo-embed" aria-labelledby="demo-embed-title">
    <div class="demo-embed__head">
      <h2 id="demo-embed-title">Try it here</h2>
      <p>
        This is the real OpenRampKit server and modal, running in your browser with mock providers. No account,
        no real money. Pick a country and a payment method, then press "Simulate payment".
      </p>
    </div>
    <div class="demo-embed__frame">
      <iframe
        :src="withBase('/playground/')"
        title="OpenRampKit live demo"
        loading="lazy"
        allow="clipboard-write"
      ></iframe>
    </div>
    <p class="demo-embed__open">
      <a :href="withBase('/playground/')" target="_self">Open the demo full screen</a>
    </p>
  </section>
</template>

<style scoped>
.demo-embed {
  max-width: 1152px;
  margin: 0 auto;
  padding: 24px 24px 48px;
}
.demo-embed__head h2 {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
  margin: 0 0 8px;
  border: none;
  padding: 0;
}
.demo-embed__head p {
  color: var(--vp-c-text-2);
  max-width: 68ch;
  margin: 0 0 20px;
}
.demo-embed__frame {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}
.demo-embed__frame iframe {
  display: block;
  width: 100%;
  height: 860px;
  border: 0;
}
@media (max-width: 640px) {
  .demo-embed {
    padding: 16px 16px 32px;
  }
  .demo-embed__frame iframe {
    height: 760px;
  }
}
.demo-embed__open {
  margin-top: 12px;
  font-size: 14px;
}
</style>
