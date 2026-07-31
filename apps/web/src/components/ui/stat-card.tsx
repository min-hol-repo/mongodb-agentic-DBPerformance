import { cn } from '@/lib/utils'

interface StatCardProps {
  label:      string
  value:      string | number
  sub?:       string
  accent?:    'red' | 'amber' | 'green' | 'blue' | 'gray'
  className?: string
}

const ACCENT_STYLES: Record<NonNullable<StatCardProps['accent']>, string> = {
  red:   'border-l-red-400',
  amber: 'border-l-amber-400',
  green: 'border-l-green-400',
  blue:  'border-l-blue-400',
  gray:  'border-l-gray-300',
}

export function StatCard({ label, value, sub, accent, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-white p-5 border-l-4',
        accent ? ACCENT_STYLES[accent] : 'border-l-gray-200',
        className,
      )}
    >
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight text-foreground">
        {value}
      </p>
      {sub && (
        <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
      )}
    </div>
  )
}
