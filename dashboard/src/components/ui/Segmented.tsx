interface Option<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  options: Option<T>[]
  value: T
  onChange: (v: T) => void
}

export default function Segmented<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <div className="glass inline-flex rounded-full p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
            value === o.value ? 'bg-white/80 text-indigo-700 shadow' : 'text-slate-600 hover:bg-white/40'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}