const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function Heatmap({ data }: { data: number[][] }) {
  const max = Math.max(...data.flat())

  return (
    <div>
      <div className="space-y-1">
        {data.map((row, d) => (
          <div key={DAYS[d]} className="flex items-center gap-1">
            <span className="w-8 text-[10px] text-slate-500">{DAYS[d]}</span>
            <div className="grid flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-1">
              {row.map((v, h) => (
                <div
                  key={h}
                  title={`${DAYS[d]} ${String(h).padStart(2, '0')}:00 - ${v} requests`}
                  className="aspect-square rounded-[4px]"
                  style={{ background: `rgba(99,102,241,${0.08 + (v / max) * 0.85})` }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="ml-9 mt-2 flex justify-between text-[10px] text-slate-500">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-slate-500">
        Quiet
        <span className="h-2.5 w-24 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(99,102,241,0.1), rgba(99,102,241,0.93))' }} />
        Busy
      </div>
    </div>
  )
}