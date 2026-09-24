export type ThemeId = 'light' | 'dark' | 'eye-care' | 'meadow' | 'mist'

export interface ThemeOption {
  id: ThemeId
  label: string
  preview:
    | { kind: 'color'; bg: string; panel?: string; accent?: string }
    | { kind: 'image'; src: string }
}

export const THEMES: readonly ThemeOption[] = [
  {
    id: 'light',
    label: 'Light',
    preview: { kind: 'color', bg: '#ffffff', panel: '#f4f4f5', accent: '#18181b' }
  },
  {
    id: 'dark',
    label: 'Dark',
    preview: { kind: 'color', bg: '#09090b', panel: '#18181b', accent: '#f4f4f5' }
  },
  {
    id: 'eye-care',
    label: 'Eye Care',
    preview: { kind: 'color', bg: '#e7f0e3', panel: '#f2f7ef', accent: '#2d5a3d' }
  },
  {
    id: 'meadow',
    label: 'Meadow',
    preview: { kind: 'image', src: '/themes/meadow.jpg' }
  },
  {
    id: 'mist',
    label: 'Mist',
    preview: { kind: 'image', src: '/themes/mist.jpg' }
  }
]

export function isThemeId(value: unknown): value is ThemeId {
  return value === 'light' || value === 'dark' || value === 'eye-care' || value === 'meadow' || value === 'mist'
}
