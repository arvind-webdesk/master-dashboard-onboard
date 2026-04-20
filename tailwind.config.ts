import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#ffffff',
          muted: '#f6f7f9',
          border: '#e5e7eb',
        },
      },
    },
  },
  plugins: [],
};

export default config;
