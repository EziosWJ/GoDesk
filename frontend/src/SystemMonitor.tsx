import { useEffect, useState } from 'react'
import { Activity, HardDrive, MemoryStick } from 'lucide-react'

const trendSeconds = 60

function trendSamples(second: number, sample: (time: number) => number) {
  return Array.from({ length: trendSeconds + 1 }, (_, index) => sample(second - trendSeconds + index))
}

function cpuUsage(second: number) {
  return Math.round(34 + 13 * Math.sin(second / 5) + 9 * Math.sin(second / 2.3) + 5 * Math.cos(second * 1.1))
}

function memoryUsage(second: number) {
  return Math.round(53 + 8 * Math.sin(second / 9) + 6 * Math.cos(second / 4.2) + 3 * Math.sin(second / 1.7))
}

function Trend({ name, samples, detail, Icon, kind }: {
  name: string
  samples: number[]
  detail: string
  Icon: typeof Activity
  kind: 'cpu' | 'memory'
}) {
  const path = samples.map((value, index) => `${index * 4},${100 - value}`).join(' ')
  const value = samples.at(-1)!

  return (
    <section className="monitor-resource" data-resource={kind} aria-label={name}>
      <header className="monitor-resource-title"><Icon size={16} aria-hidden="true" /><h3>{name}</h3></header>
      <div className="monitor-reading"><strong>{value}<span>%</span></strong><span className="system-caption">{detail}</span></div>
      <figure className="monitor-trend system-caption" aria-label={`${name}最近 60 秒，最低 ${Math.min(...samples)}%，最高 ${Math.max(...samples)}%`}>
        <div className="monitor-scale" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
        <svg viewBox="0 0 240 100" preserveAspectRatio="none" aria-hidden="true">
          <path className="monitor-gridlines" d="M0 0H240 M0 50H240 M0 100H240 M0 0V100 M120 0V100 M240 0V100" vectorEffect="non-scaling-stroke" />
          <polygon className="monitor-fill" points={`0,100 ${path} 240,100`} />
          <polyline className="monitor-line" points={path} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="monitor-time" aria-hidden="true"><span>60 秒前</span><span>现在</span></div>
      </figure>
    </section>
  )
}

function currentSecond() {
  return Math.floor(Date.now() / 1000)
}

export function SystemMonitor() {
  const [second, setSecond] = useState(currentSecond)

  useEffect(() => {
    const timer = window.setInterval(() => setSecond(currentSecond()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const cpu = trendSamples(second, cpuUsage)
  const memory = trendSamples(second, memoryUsage)
  const usedMemory = ((memory.at(-1) ?? 0) * 8 / 100).toFixed(1)
  const diskUsed = 61
  const diskCapacity = 100

  return (
    <div className="monitor-page">
      <div className="monitor-overview">
        <header className="monitor-heading">
          <h2 className="system-subtitle">资源使用</h2>
          <span className="system-caption">模拟数据 · 每秒更新</span>
        </header>
        <div className="monitor-trends">
          <Trend name="CPU" samples={cpu} detail="4 核" Icon={Activity} kind="cpu" />
          <Trend name="内存" samples={memory} detail={`${usedMemory} / 8 GB`} Icon={MemoryStick} kind="memory" />
        </div>
        <section className="monitor-disk" aria-labelledby="monitor-disk-title">
          <header className="monitor-resource-title">
            <HardDrive size={16} aria-hidden="true" /><h3 id="monitor-disk-title">磁盘</h3><strong>{diskUsed}%</strong>
          </header>
          <meter aria-labelledby="monitor-disk-title" min={0} max={diskCapacity} value={diskUsed} />
          <div className="monitor-disk-capacity system-caption"><span>已用 {diskUsed} GB</span><span>可用 {diskCapacity - diskUsed} GB</span></div>
        </section>
      </div>
    </div>
  )
}
