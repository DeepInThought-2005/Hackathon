const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/[/]$/, '')

export type CurrentUser = { id: string; name: string }

export class IdentityError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Could not load the signed-in user')
    this.status = status
  }
}

export async function getCurrentUser(
  signal?: AbortSignal,
): Promise<CurrentUser> {
  const response = await fetch(baseUrl + '/api/me', {
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new IdentityError(response.status)
  const data: unknown = await response.json()
  if (
    typeof data !== 'object' ||
    data === null ||
    !('id' in data) ||
    typeof data.id !== 'string' ||
    !data.id.trim() ||
    !('name' in data) ||
    typeof data.name !== 'string' ||
    !data.name.trim()
  )
    throw new Error('Unexpected user profile response')
  return { id: data.id, name: data.name }
}

// Dashboards receive the user from App; this event lets App show a new name everywhere.
export const USER_CHANGED_EVENT = 'askpool:user-changed'

export async function updateUsername(name: string): Promise<CurrentUser> {
  const response = await fetch(baseUrl + '/api/me', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(
      data?.error || `Could not save your name (${response.status}).`,
    )
  const user: CurrentUser = { id: data.id, name: data.name }
  window.dispatchEvent(new CustomEvent(USER_CHANGED_EVENT, { detail: user }))
  return user
}

export type HelloResponse = { message: string }

export async function getHello(): Promise<HelloResponse> {
  const response = await fetch(baseUrl + '/api/hello')
  if (!response.ok) throw new Error('Request failed: ' + response.status)

  const data: unknown = await response.json()
  if (
    typeof data !== 'object' ||
    data === null ||
    !('message' in data) ||
    typeof data.message !== 'string'
  ) {
    throw new Error('The API returned an unexpected response')
  }
  return { message: data.message }
}
