import qrcode from 'qrcode-generator'

/** Encode text as a QR code and return the module count and one SVG path for the dark modules. */
export function qrPath(text: string): { size: number; path: string } {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const size = qr.getModuleCount()
  let path = ''
  for (let r = 0; r < size; r++) {
    let c = 0
    while (c < size) {
      if (!qr.isDark(r, c)) {
        c++
        continue
      }
      // Merge horizontal runs into one rectangle to keep the path small.
      const start = c
      while (c < size && qr.isDark(r, c)) c++
      path += `M${start} ${r}h${c - start}v1h${start - c}z`
    }
  }
  return { size, path }
}
