import { useState } from 'react'

/**
 * A small text field that submits on Enter and cancels on Escape or blur.
 * The initial text is selected, so typing replaces it. Enter on an empty value calls `onEmpty`.
 */
export function InlineInput(props: { initial?: string; placeholder?: string; onSubmit: (value: string) => void; onCancel: () => void; onEmpty?: () => void }) {
  const [value, setValue] = useState(props.initial ?? '')
  return (
    <input
      className="inline-input"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      value={value}
      placeholder={props.placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={props.onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (value.trim()) props.onSubmit(value.trim())
          else props.onEmpty?.()
        }
        if (e.key === 'Escape') props.onCancel()
      }}
    />
  )
}
