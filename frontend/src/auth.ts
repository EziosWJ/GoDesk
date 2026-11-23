export type Session =
  | { status: 'setup' | 'login' }
  | { status: 'authenticated'; expiresAt: string }

export class AuthError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Authentication request failed (${status})`)
    this.status = status
  }
}

export async function authSession(
  action: 'session' | 'setup' | 'login' | 'logout' | 'password',
  body: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Session> {
  const response = await fetch(`/api/v1/auth/${action}`, action === 'session'
    ? { signal }
    : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  if (!response.ok) throw new AuthError(response.status)
  return response.json()
}
