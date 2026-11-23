import { LockKeyhole } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import App from './App'
import './styles/login.css'

const sessionKey = 'react-web-desktop-demo-session'
const demoPassword = 'react-web-desktop'

function readSession() {
  try {
    return sessionStorage.getItem(sessionKey) === 'active'
  } catch {
    return false
  }
}

function LoginPage({ onLogin }: { onLogin: () => void }) {
  const password = useRef<HTMLInputElement>(null)
  const [passwordError, setPasswordError] = useState(false)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = password.current!
    if (input.value === demoPassword) {
      onLogin()
      return
    }
    setPasswordError(true)
    input.focus()
    input.select()
  }

  return (
    <main className="login-screen" aria-label="React Web Desktop 登录">
      <div className="login-card">
        <header className="login-brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={64} height={64} />
          <h1>React Web Desktop</h1>
        </header>
        <form className="login-form" onSubmit={submit}>
          <div className="login-field">
            <LockKeyhole size={18} aria-hidden="true" />
            <input ref={password} name="password" type="password" aria-label="密码" placeholder="请输入密码"
              autoComplete="off" autoFocus required aria-invalid={passwordError || undefined}
              aria-describedby={passwordError ? 'login-password-error' : undefined}
              onChange={() => setPasswordError(false)} />
          </div>
          {passwordError && <p className="login-error" id="login-password-error" role="alert">密码错误，请重试</p>}
          <button className="login-submit" type="submit">登录</button>
        </form>
      </div>
    </main>
  )
}

export default function DemoSession() {
  const [loggedIn, setLoggedIn] = useState(readSession)

  function updateSession(active: boolean) {
    try {
      if (active) sessionStorage.setItem(sessionKey, 'active')
      else sessionStorage.removeItem(sessionKey)
    } catch {
      // The demo still works until reload when session storage is unavailable.
    }
    setLoggedIn(active)
  }

  return loggedIn
    ? <App onLogout={() => updateSession(false)} />
    : <LoginPage onLogin={() => updateSession(true)} />
}
