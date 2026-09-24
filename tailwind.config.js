/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Radius convention (keep consistent across components):
      //   controls (buttons, inputs, chips) = rounded-md
      //   panels / menus / cards = rounded-lg
      //   large containers = rounded-xl
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)']
      }
    }
  },
  plugins: []
}
