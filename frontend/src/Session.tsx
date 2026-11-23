import { LockKeyhole } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import App from './App'
import { AuthError, authSession, type Session as AuthSession } from './auth'
import './styles/login.css'

function LoginScreen({ children, label }: { children: ReactNode; label: string }) {
  return (
    <main className="login-screen" aria-label={label}>
      <div className="login-card">
        <header className="login-brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={64} height={64} />
          <h1>goDesk</h1>
        </header>
        {children}
      </div>
    </main>
  )
}

function PasswordPage({ setup, onSession }: { setup: boolean; onSession: (session: AuthSession) => void }) {
  const password = useRef<HTMLInputElement>(null)
  const confirmation = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const title = setup ? '创建密码' : '登录'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = password.current!
    const value = input.value
    if (setup && value !== confirmation.current?.value) {
      setError('两次输入的密码不一致')
      confirmation.current?.select()
      return
    }
    setError('')
    setPending(true)
    try {
      onSession(await authSession(setup ? 'setup' : 'login', { password: value }))
    } catch (failure) {
      if (failure instanceof AuthError && failure.status === 409) {
        onSession({ status: setup ? 'login' : 'setup' })
      } else if (failure instanceof AuthError && failure.status === 401) {
        setError('密码错误，请重试')
        input.select()
      } else {
        setError('无法完成请求，请重试')
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <LoginScreen label={title}>
      <form className="login-form" onSubmit={submit} onChange={() => setError('')}>
        <div className="login-field">
          <LockKeyhole size={18} aria-hidden="true" />
          <input ref={password} name="password" type="password" aria-label="密码"
            placeholder={setup ? '请输入新密码' : '请输入密码'}
            autoComplete={setup ? 'new-password' : 'current-password'} autoFocus required />
        </div>
        {setup && (
          <div className="login-field">
            <LockKeyhole size={18} aria-hidden="true" />
            <input ref={confirmation} name="confirmation" type="password" aria-label="确认密码"
              placeholder="请再次输入新密码" autoComplete="new-password" required />
          </div>
        )}
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-submit" type="submit" disabled={pending}>{title}</button>
      </form>
    </LoginScreen>
  )
}

export default function Session() {
  const [session, setSession] = useState<AuthSession>()
  const [attempt, setAttempt] = useState(0)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    authSession('session', {}, controller.signal).then(setSession, () => {
      if (!controller.signal.aborted) setUnavailable(true)
    })
    return () => controller.abort()
  }, [attempt])

  useEffect(() => {
    if (session?.status !== 'authenticated') return
    const timer = window.setTimeout(() => setSession({ status: 'login' }), Date.parse(session.expiresAt) - Date.now())
    return () => window.clearTimeout(timer)
  }, [session])

  if (!session) {
    return (
      <LoginScreen label="登录状态">
        <div className="login-form">
          {unavailable ? (
            <>
              <p className="login-error" role="alert">无法连接 goDesk 服务</p>
              <button className="login-submit" type="button" onClick={() => {
                setUnavailable(false)
                setAttempt(value => value + 1)
              }}>重试</button>
            </>
          ) : <p role="status">正在检查登录状态…</p>}
        </div>
      </LoginScreen>
    )
  }

  return session.status === 'authenticated'
    ? <App onSession={setSession} onLogout={async () => setSession(await authSession('logout'))} />
    : <PasswordPage key={session.status} setup={session.status === 'setup'} onSession={setSession} />
}
