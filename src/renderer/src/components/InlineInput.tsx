import { useState } from 'react'

/** A small text field that submits on Enter and cancels on Escape or blur. */
export function InlineInput(props: { initial?: string; placeholder?: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.initial ?? '')
  return (
    <input
      className="inline-input"
      autoFocus
      value={value}
      placeholder={props.placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={props.onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) props.onSubmit(value.trim())
        if (e.key === 'Escape') props.onCancel()
      }}
    />
  )
}
