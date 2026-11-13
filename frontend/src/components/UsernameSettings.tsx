import { useState } from 'react'
import { updateUsername, type CurrentUser } from '../lib/api'
import './username-settings.css'

// Shared by the Student and Professor settings pages.
export default function UsernameSettings({ user }: { user: CurrentUser }) {
  const [draft, setDraft] = useState(user.name)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string }>()
  const unchanged = draft.trim() === user.name

  async function save() {
    setSaving(true)
    setMessage(undefined)
    try {
      const saved = await updateUsername(draft)
      setDraft(saved.name)
      setMessage({ error: false, text: 'Name saved.' })
    } catch (cause) {
      setMessage({
        error: true,
        text:
          cause instanceof Error ? cause.message : 'Could not save your name.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      className="username-settings"
      aria-labelledby="username-settings-title"
    >
      <h2 id="username-settings-title">Your name</h2>
      <p>Shown in your profile. Leave it empty to use your guest name.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!saving && !unchanged) void save()
        }}
      >
        <label htmlFor="username-settings-input" className="sr-only">
          Your name
        </label>
        <div className="username-settings-row">
          <input
            id="username-settings-input"
            value={draft}
            maxLength={40}
            autoComplete="nickname"
            disabled={saving}
            onChange={(event) => {
              setDraft(event.target.value)
              setMessage(undefined)
            }}
          />
          <button type="submit" disabled={saving || unchanged}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
      {message && (
        <p
          role={message.error ? 'alert' : 'status'}
          className={
            message.error
              ? 'username-settings-error'
              : 'username-settings-saved'
          }
        >
          {message.text}
        </p>
      )}
    </section>
  )
}
