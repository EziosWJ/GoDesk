import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Check, Info, RefreshCw, Search } from 'lucide-react'
import type { Session } from './auth'
import {
  HostError,
  capabilityReasonMessage,
  formatBuildMeta,
  formatCpuSummary,
  formatUptime,
  hostApi,
  hostMutationErrorMessage,
  type HostInfo,
} from './host'
import { formatBytes } from './monitor'

export function HostSettings({ onSession }: { onSession: (session: Session) => void }) {
  const [info, setInfo] = useState<HostInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')

  const [hostnameDraft, setHostnameDraft] = useState('')
  const [savingHostname, setSavingHostname] = useState(false)
  const [hostnameError, setHostnameError] = useState('')
  const [hostnameSuccess, setHostnameSuccess] = useState('')

  const [timezones, setTimezones] = useState<string[] | null>(null)
  const [timezonesError, setTimezonesError] = useState('')
  const [timezoneAttempt, setTimezoneAttempt] = useState(0)
  const [timezoneQuery, setTimezoneQuery] = useState('')
  const [selectedTimezone, setSelectedTimezone] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [savingTimezone, setSavingTimezone] = useState(false)
  const [timezoneError, setTimezoneError] = useState('')
  const [timezoneSuccess, setTimezoneSuccess] = useState('')

  const loadControllerRef = useRef<AbortController | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const applyHostInfo = useCallback((next: HostInfo) => {
    setInfo(prev => {
      setHostnameDraft(current => (!prev || current === prev.hostname ? next.hostname : current))
      setSelectedTimezone(current => (!prev || current === prev.timezone ? next.timezone : current))
      return next
    })
  }, [])

  const handleInfoFailure = useCallback((failure: unknown) => {
    if (failure instanceof HostError && failure.status === 401) {
      onSession({ status: 'login' })
      return
    }
    setLoadError(failure instanceof HostError && failure.message ? failure.message : '无法读取主机信息，请重试')
  }, [onSession])

  useEffect(() => {
    const controller = new AbortController()
    loadControllerRef.current = controller
    hostApi.info(controller.signal).then(next => {
      if (controller.signal.aborted) return
      applyHostInfo(next)
      setLoading(false)
    }, failure => {
      if (controller.signal.aborted) return
      handleInfoFailure(failure)
      setLoading(false)
    })
    return () => controller.abort()
  }, [applyHostInfo, handleInfoFailure])

  const refreshHostInfo = useCallback(async (isInitial: boolean) => {
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    if (isInitial) {
      setLoading(true)
    } else {
      setRefreshing(true)
    }
    setLoadError('')
    try {
      const next = await hostApi.info(controller.signal)
      if (controller.signal.aborted) return
      applyHostInfo(next)
    } catch (failure) {
      if (controller.signal.aborted) return
      handleInfoFailure(failure)
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [applyHostInfo, handleInfoFailure])

  const canSetTimezone = info?.capabilities.setTimezone ?? false
  const timezonesLoading = canSetTimezone && timezones === null && !timezonesError

  useEffect(() => {
    if (!canSetTimezone || timezones !== null) return
    const controller = new AbortController()
    hostApi.timezones(controller.signal).then(list => {
      if (!controller.signal.aborted) {
        setTimezones(list)
      }
    }, failure => {
      if (controller.signal.aborted) return
      if (failure instanceof HostError && failure.status === 401) {
        onSession({ status: 'login' })
        return
      }
      setTimezonesError(failure instanceof HostError && failure.message ? failure.message : '无法加载时区列表')
    })
    return () => controller.abort()
  }, [canSetTimezone, timezones, timezoneAttempt, onSession])

  const filteredTimezones = useMemo(() => {
    if (!timezones) return []
    const needle = timezoneQuery.trim().toLowerCase()
    if (!needle) return timezones
    const prefixMatches: string[] = []
    const otherMatches: string[] = []
    for (const tz of timezones) {
      const lower = tz.toLowerCase()
      if (!lower.includes(needle)) continue
      if (lower.startsWith(needle)) {
        prefixMatches.push(tz)
      } else {
        otherMatches.push(tz)
      }
    }
    return [...prefixMatches, ...otherMatches]
  }, [timezones, timezoneQuery])

  const safeActiveIndex = filteredTimezones.length === 0
    ? 0
    : Math.min(activeIndex, filteredTimezones.length - 1)

  const trimmedHostname = hostnameDraft.trim()
  const hostnameUnchanged = info ? trimmedHostname === info.hostname : true
  const timezoneUnchanged = info ? selectedTimezone === info.timezone : true

  async function saveHostname(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!info || !info.capabilities.setHostname || !trimmedHostname || hostnameUnchanged) return
    setSavingHostname(true)
    setHostnameError('')
    setHostnameSuccess('')
    try {
      const result = await hostApi.setHostname(trimmedHostname)
      setHostnameDraft(result.hostname)
      setInfo(prev => (prev ? { ...prev, hostname: result.hostname } : prev))
      setHostnameSuccess(`主机名已更新为 ${result.hostname}`)
      void refreshHostInfo(false)
    } catch (failure) {
      if (failure instanceof HostError && failure.status === 401) {
        onSession({ status: 'login' })
        return
      }
      setHostnameError(hostMutationErrorMessage('hostname', failure))
    } finally {
      setSavingHostname(false)
    }
  }

  async function saveTimezone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!info || !info.capabilities.setTimezone || !selectedTimezone || timezoneUnchanged) return
    setSavingTimezone(true)
    setTimezoneError('')
    setTimezoneSuccess('')
    try {
      const result = await hostApi.setTimezone(selectedTimezone)
      setSelectedTimezone(result.timezone)
      setInfo(prev => (prev ? { ...prev, timezone: result.timezone } : prev))
      setTimezoneSuccess(`时区已更新为 ${result.timezone}`)
      void refreshHostInfo(false)
    } catch (failure) {
      if (failure instanceof HostError && failure.status === 401) {
        onSession({ status: 'login' })
        return
      }
      setTimezoneError(hostMutationErrorMessage('timezone', failure))
    } finally {
      setSavingTimezone(false)
    }
  }

  function selectTimezoneOption(tz: string, index: number) {
    setSelectedTimezone(tz)
    setActiveIndex(index)
    setTimezoneError('')
    setTimezoneSuccess('')
  }

  function handleTimezoneSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (filteredTimezones.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = Math.min(safeActiveIndex + 1, filteredTimezones.length - 1)
      setActiveIndex(next)
      optionRefs.current[next]?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const prev = Math.max(safeActiveIndex - 1, 0)
      setActiveIndex(prev)
      optionRefs.current[prev]?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = filteredTimezones[safeActiveIndex]
      if (target) selectTimezoneOption(target, safeActiveIndex)
    }
  }

  const buildMeta = info ? formatBuildMeta(info.commit, info.buildDate) : ''

  return (
    <>
      <section className="settings-section" aria-labelledby="host-info-title">
        <div className="settings-section-head">
          <h3 id="host-info-title">主机信息</h3>
          <button
            type="button"
            className="app-control host-refresh-button"
            disabled={loading || refreshing}
            onClick={() => void refreshHostInfo(info === null)}
          >
            <RefreshCw size={14} className={refreshing ? 'host-spin' : undefined} aria-hidden="true" />
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>

        {loading && !info ? (
          <p className="system-caption" role="status">正在读取主机信息…</p>
        ) : !info ? (
          <div className="host-load-error">
            <p className="authentication-error" role="alert">{loadError || '无法读取主机信息'}</p>
            <button type="button" className="app-control" onClick={() => void refreshHostInfo(true)}>重试</button>
          </div>
        ) : (
          <>
            {loadError && <p className="authentication-error host-inline-feedback" role="alert">{loadError}</p>}
            <dl className="host-info-grid">
              <div className="host-info-item">
                <dt>主机名</dt>
                <dd className="host-mono">{info.hostname || '—'}</dd>
              </div>
              <div className="host-info-item">
                <dt>时区</dt>
                <dd className="host-mono">{info.timezone || '—'}</dd>
              </div>
              <div className="host-info-item">
                <dt>操作系统</dt>
                <dd>{info.os || '—'}</dd>
              </div>
              <div className="host-info-item">
                <dt>内核版本</dt>
                <dd className="host-mono">{info.kernel || '—'}</dd>
              </div>
              <div className="host-info-item">
                <dt>CPU 架构</dt>
                <dd className="host-mono">{info.arch || '—'}</dd>
              </div>
              <div className="host-info-item">
                <dt>处理器</dt>
                <dd>{formatCpuSummary(info.cpuModel, info.logicalCores)}</dd>
              </div>
              <div className="host-info-item">
                <dt>内存总量</dt>
                <dd>{info.memoryTotalBytes > 0 ? formatBytes(info.memoryTotalBytes) : '—'}</dd>
              </div>
              <div className="host-info-item">
                <dt>运行时间</dt>
                <dd>{formatUptime(info.uptimeSeconds)}</dd>
              </div>
              <div className="host-info-item">
                <dt>GoDesk 版本</dt>
                <dd className="host-version-value">
                  <span className="host-mono">{info.version || '—'}</span>
                  {buildMeta && <span className="system-caption host-mono">{buildMeta}</span>}
                </dd>
              </div>
              <div className="host-info-item">
                <dt>运行账号</dt>
                <dd className="host-account-value">
                  <span className="host-mono">{info.user || '—'}</span>
                  {info.isRoot && <span className="host-badge host-badge-root">root</span>}
                </dd>
              </div>
            </dl>
          </>
        )}
      </section>

      {info && (
        <section className="settings-section" aria-labelledby="host-config-title">
          <div className="settings-section-head">
            <h3 id="host-config-title">主机名与时区</h3>
            <p className="system-caption">修改将直接应用到当前主机</p>
          </div>

          <div className="host-config-stack">
            <div className="host-config-card">
              <div className="host-config-label-row">
                {info.capabilities.setHostname ? (
                  <label className="host-config-label" htmlFor="host-hostname-input">主机名</label>
                ) : (
                  <span className="host-config-label">主机名</span>
                )}
                {!info.capabilities.setHostname && <span className="host-badge">只读</span>}
              </div>

              {info.capabilities.setHostname ? (
                <form className="host-inline-form" onSubmit={saveHostname}>
                  <div className="host-inline-row">
                    <input
                      id="host-hostname-input"
                      className="host-input host-mono"
                      type="text"
                      value={hostnameDraft}
                      maxLength={64}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={savingHostname}
                      onChange={event => {
                        setHostnameDraft(event.target.value)
                        setHostnameError('')
                        setHostnameSuccess('')
                      }}
                    />
                    <button
                      type="submit"
                      className="app-control primary-control"
                      disabled={savingHostname || !trimmedHostname || hostnameUnchanged}
                    >
                      {savingHostname ? '保存中…' : '保存主机名'}
                    </button>
                  </div>
                  {hostnameError && <p className="authentication-error host-inline-feedback" role="alert">{hostnameError}</p>}
                  {hostnameSuccess && <p className="host-success-feedback" role="status">{hostnameSuccess}</p>}
                </form>
              ) : (
                <>
                  <p className="host-readonly-value host-mono">{info.hostname || '—'}</p>
                  <p className="host-readonly-note">
                    <Info size={14} aria-hidden="true" />
                    <span>{capabilityReasonMessage('hostname', info.capabilities.hostnameReason)}</span>
                  </p>
                </>
              )}
            </div>

            <div className="host-config-card">
              <div className="host-config-label-row">
                {info.capabilities.setTimezone ? (
                  <label className="host-config-label" htmlFor="host-timezone-search">系统时区</label>
                ) : (
                  <span className="host-config-label">系统时区</span>
                )}
                {!info.capabilities.setTimezone && <span className="host-badge">只读</span>}
              </div>

              {info.capabilities.setTimezone ? (
                <form className="host-timezone-form" onSubmit={saveTimezone}>
                  <div className="host-timezone-current">
                    <span className="system-caption">当前已选</span>
                    <code className="host-timezone-selected">{selectedTimezone || '—'}</code>
                    {!timezoneUnchanged && <span className="host-badge host-badge-pending">未保存</span>}
                  </div>

                  <div className="host-timezone-search-wrap">
                    <Search size={14} className="host-timezone-search-icon" aria-hidden="true" />
                    <input
                      id="host-timezone-search"
                      className="host-input host-timezone-search"
                      type="search"
                      value={timezoneQuery}
                      placeholder="搜索 IANA 时区，例如 Asia/Shanghai 或 UTC"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={savingTimezone || timezonesLoading}
                      aria-controls="host-timezone-listbox"
                      onKeyDown={handleTimezoneSearchKeyDown}
                      onChange={event => {
                        setTimezoneQuery(event.target.value)
                        setActiveIndex(0)
                      }}
                    />
                  </div>

                  {timezonesLoading ? (
                    <p className="system-caption" role="status">正在加载时区列表…</p>
                  ) : timezonesError ? (
                    <div className="host-load-error">
                      <p className="authentication-error" role="alert">{timezonesError}</p>
                      <button
                        type="button"
                        className="app-control"
                        onClick={() => {
                          setTimezonesError('')
                          setTimezones(null)
                          setTimezoneAttempt(value => value + 1)
                        }}
                      >
                        重试加载
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="host-timezone-meta">
                        <span className="system-caption">
                          {timezoneQuery.trim()
                            ? `匹配 ${filteredTimezones.length} / ${timezones?.length ?? 0} 个时区`
                            : `共 ${timezones?.length ?? 0} 个可选时区`}
                        </span>
                        <span className="system-caption">支持 ↑↓ 选择、Enter 确认</span>
                      </div>
                      <div
                        id="host-timezone-listbox"
                        className="host-timezone-list system-scroll"
                        role="listbox"
                        aria-label="IANA 时区列表"
                      >
                        {filteredTimezones.length === 0 ? (
                          <p className="system-caption host-timezone-empty">未找到匹配的时区</p>
                        ) : (
                          filteredTimezones.map((tz, index) => {
                            const selected = tz === selectedTimezone
                            const highlighted = index === safeActiveIndex
                            return (
                              <button
                                key={tz}
                                ref={node => { optionRefs.current[index] = node }}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                data-highlighted={highlighted || undefined}
                                className="host-timezone-option"
                                disabled={savingTimezone}
                                onClick={() => selectTimezoneOption(tz, index)}
                              >
                                <span className="host-mono">{tz}</span>
                                {tz === info.timezone && <span className="host-timezone-tag">当前</span>}
                                {selected && <Check size={14} className="host-timezone-check" aria-hidden="true" />}
                              </button>
                            )
                          })
                        )}
                      </div>
                    </>
                  )}

                  {timezoneError && <p className="authentication-error host-inline-feedback" role="alert">{timezoneError}</p>}
                  {timezoneSuccess && <p className="host-success-feedback" role="status">{timezoneSuccess}</p>}

                  <div className="host-timezone-actions">
                    <button
                      type="submit"
                      className="app-control primary-control"
                      disabled={savingTimezone || !selectedTimezone || timezoneUnchanged}
                    >
                      {savingTimezone ? '保存中…' : '保存时区'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="host-readonly-value host-mono">{info.timezone || '—'}</p>
                  <p className="host-readonly-note">
                    <Info size={14} aria-hidden="true" />
                    <span>{capabilityReasonMessage('timezone', info.capabilities.timezoneReason)}</span>
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </>
  )
}
