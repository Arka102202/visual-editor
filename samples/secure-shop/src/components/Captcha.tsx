// C21: a Cloudflare Turnstile CAPTCHA (its script loads from Cloudflare; the dev backend accepts any solved token).
import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, options: { sitekey: string; callback: (token: string) => void }) => string }
  }
}

export function Captcha({ onSolved }: { onSolved: (token: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const draw = () => box.current && window.turnstile?.render(box.current, { sitekey: '1x00000000000000000000AA', callback: onSolved })
    if (window.turnstile) return void draw()
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
    s.async = true
    s.onload = draw
    document.head.append(s)
  }, [onSolved])
  return <div ref={box} />
}
