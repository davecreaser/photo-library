import { useId, useState } from 'react'
import type { Tag } from '../../../shared/types.ts'

/** Text field with autocomplete from existing tags. */
export function TagInput(props: { tags: Tag[]; onAdd: (name: string) => void; placeholder?: string }) {
  const [value, setValue] = useState('')
  const listId = useId()
  return (
    <>
      <input
        className="tag-input"
        list={listId}
        value={value}
        placeholder={props.placeholder ?? 'Add tag…'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            props.onAdd(value.trim().replace(/^#/, ''))
            setValue('')
          }
          e.stopPropagation()
        }}
      />
      <datalist id={listId}>
        {props.tags.map((t) => <option key={t.id} value={t.name} />)}
      </datalist>
    </>
  )
}
