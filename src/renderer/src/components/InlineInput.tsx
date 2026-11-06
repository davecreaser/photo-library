import { useRef, useState } from 'react'

/**
 * A small text field that submits on Enter and cancels on Escape or blur.
 * The initial text is selected, so typing replaces it. Enter on an empty value calls `onEmpty`.
 * Submits at most once (a repeated Enter can't, say, make two albums); if `onSubmit` returns a
 * promise that rejects, it can be submitted again.
 */
export function InlineInput(props: {
  initial?: string
  placeholder?: string
  onSubmit: (value: string) => void | Promise<unknown>
  onCancel: () => void
  onEmpty?: () => void
}) {
  const [value, setValue] = useState(props.initial ?? '')
  const submitted = useRef(false)
  return (
    <input
      className="inline-input"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      value={value}
      placeholder={props.placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => submitted.current || props.onCancel()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !submitted.current) {
          if (value.trim()) {
            submitted.current = true
            void Promise.resolve(props.onSubmit(value.trim())).catch(() => {
              submitted.current = false
            })
          } else props.onEmpty?.()
        }
        if (e.key === 'Escape') props.onCancel()
      }}
    />
  )
}
