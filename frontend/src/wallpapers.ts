import bloomLight from './assets/wallpapers/bloom-light.svg'
import bloomDark from './assets/wallpapers/bloom-dark.svg'
import auroraLight from './assets/wallpapers/aurora-light.svg'
import auroraDark from './assets/wallpapers/aurora-dark.svg'
import prismLight from './assets/wallpapers/prism-light.svg'
import prismDark from './assets/wallpapers/prism-dark.svg'
import sunsetLight from './assets/wallpapers/sunset-light.svg'
import sunsetDark from './assets/wallpapers/sunset-dark.svg'
import graphiteLight from './assets/wallpapers/graphite-light.svg'
import graphiteDark from './assets/wallpapers/graphite-dark.svg'

export const wallpapers = {
  bloom: {
    name: '蓝韵花瓣',
    description: 'Windows 11 经典流体光影',
    light: bloomLight,
    dark: bloomDark,
  },
  aurora: {
    name: '极光云雾',
    description: '青蓝薄雾与极光丝带',
    light: auroraLight,
    dark: auroraDark,
  },
  prism: {
    name: '暮紫棱镜',
    description: '柔和鸢尾紫与微光弧线',
    light: prismLight,
    dark: prismDark,
  },
  sunset: {
    name: '晨曦琥珀',
    description: '暖金珊瑚与暮色柔光',
    light: sunsetLight,
    dark: sunsetDark,
  },
  graphite: {
    name: '静谧灰阶',
    description: '极简建筑光影中性灰',
    light: graphiteLight,
    dark: graphiteDark,
  },
} as const

export type WallpaperId = keyof typeof wallpapers
export const wallpaperIds = Object.keys(wallpapers) as WallpaperId[]

const wallpaperKey = 'godesk-wallpaper'
const listeners = new Set<() => void>()

function resolveWallpaper(raw: string | null | undefined): WallpaperId {
  if (raw && Object.hasOwn(wallpapers, raw)) return raw as WallpaperId
  if (raw === 'iris' || raw === 'lavender') return 'prism'
  return 'bloom'
}

let currentWallpaper: WallpaperId = 'bloom'
try {
  currentWallpaper = resolveWallpaper(localStorage.getItem(wallpaperKey))
} catch {
  // Keep default wallpaper when storage is unavailable.
}

export function getWallpaperPreference(): WallpaperId {
  return currentWallpaper
}

export function setWallpaperPreference(next: WallpaperId) {
  try {
    localStorage.setItem(wallpaperKey, next)
  } catch {
    // Wallpaper still applies for the current session without storage.
  }
  if (currentWallpaper === next) return
  currentWallpaper = next
  for (const listener of listeners) listener()
}

export function subscribeWallpaper(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
