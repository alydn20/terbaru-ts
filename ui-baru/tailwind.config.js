/** Tailwind untuk tampilan baru. Warna memakai variabel CSS (lihat src/app.css) supaya tema gelap/terang cukup ganti variabel. */
const v = name => `rgb(var(--${name}) / <alpha-value>)`

module.exports = {
  content: ['./pages/**/*.html', './js/**/*.js'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        card: v('card'),
        card2: v('card2'),
        line: v('line'),
        ink: v('ink'),
        muted: v('muted'),
        gold: v('gold'),
        up: v('up'),
        down: v('down'),
        sky: v('sky')
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      },
      borderRadius: { xl2: '1.25rem' },
      keyframes: {
        flashUp: { '0%': { backgroundColor: 'rgb(var(--up) / 0.22)' }, '100%': { backgroundColor: 'transparent' } },
        flashDown: { '0%': { backgroundColor: 'rgb(var(--down) / 0.22)' }, '100%': { backgroundColor: 'transparent' } },
        shake: { '0%,100%': { transform: 'translateX(0)' }, '20%,60%': { transform: 'translateX(-6px)' }, '40%,80%': { transform: 'translateX(6px)' } }
      },
      animation: {
        'flash-up': 'flashUp 1.2s ease-out',
        'flash-down': 'flashDown 1.2s ease-out',
        shake: 'shake 0.5s ease-in-out'
      }
    }
  },
  plugins: []
}
