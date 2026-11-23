import { CircleCheck, CircleHelp, CircleMinus, CirclePlay, CircleX, type LucideIcon } from 'lucide-react'
import type { ServiceAction, ServiceBootState, ServiceState } from './services'

export const statusLabels: Record<ServiceState, { label: string; Icon: LucideIcon }> = {
  running: { label: '运行中', Icon: CirclePlay },
  completed: { label: '已完成', Icon: CircleCheck },
  stopped: { label: '已停止', Icon: CircleMinus },
  failed: { label: '失败', Icon: CircleX },
  unknown: { label: '未知', Icon: CircleHelp },
}

export const bootStateLabels: Record<ServiceBootState, string> = {
  enabled: '已启用',
  disabled: '已禁用',
  static: '静态',
  masked: '已屏蔽',
  runtime: '仅本次运行',
  not_applicable: '不适用',
}

export const actionLabels: Record<ServiceAction, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  enable: '启用开机自启',
  disable: '禁用开机自启',
}

export const actionProgress: Record<ServiceAction, string> = {
  start: '正在启动服务…',
  stop: '正在停止服务…',
  restart: '正在重启服务…',
  enable: '正在启用开机自启…',
  disable: '正在禁用开机自启…',
}

export const confirmationTitles: Record<'stop' | 'restart' | 'disable', string> = {
  stop: '停止服务？',
  restart: '重启服务？',
  disable: '禁用开机自启？',
}

export const confirmationWarnings: Record<'stop' | 'restart' | 'disable', string> = {
  stop: '停止后依赖它的功能可能中断。',
  restart: '重启会短暂中断依赖它的功能。',
  disable: '禁用后服务不会在下次开机时自动启动，当前运行状态不受影响。',
}

export const confirmationLabels: Record<'stop' | 'restart' | 'disable', string> = {
  stop: '停止服务',
  restart: '重启服务',
  disable: '禁用开机自启',
}

export function formatClock(date: Date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':')
}

export function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(ns: number | null | undefined) {
  if (ns === null || ns === undefined) return '—'
  const totalSeconds = ns / 1e9
  if (totalSeconds < 1) return `${Math.round(ns / 1e6)} ms`
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} 秒`
  const seconds = Math.round(totalSeconds)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分`
  return `${minutes} 分 ${seconds % 60} 秒`
}
