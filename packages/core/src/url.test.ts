import { describe, expect, it } from 'vitest'
import { isSafeLinkUrl, isWebUrl } from './index.js'

describe('URL checks', () => {
  it('isWebUrl accepts https, and http only when allowed', () => {
    expect(isWebUrl('https://pay.example.com/x')).toBe(true)
    expect(isWebUrl('http://localhost:3000/x')).toBe(false)
    expect(isWebUrl('http://localhost:3000/x', { allowHttp: true })).toBe(true)
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>1</script>', '/relative', '', 42, undefined]) {
      expect(isWebUrl(bad, { allowHttp: true })).toBe(false)
    }
  })

  it('isSafeLinkUrl accepts web and app schemes, and refuses script and local schemes', () => {
    expect(isSafeLinkUrl('https://pay.example.com')).toBe(true)
    expect(isSafeLinkUrl('gcash://pay?x=1')).toBe(true)
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'jAvAsCrIpT:alert(1)', 'data:text/html,x', 'vbscript:x', 'blob:https://a/b', 'file:///etc/passwd', 'about:blank', 'not a url', null]) {
      expect(isSafeLinkUrl(bad)).toBe(false)
    }
  })
})
