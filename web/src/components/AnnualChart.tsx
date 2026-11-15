import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useI18n } from '../i18n/useI18n'

export interface AnnualPoint {
  year: number
  total: number
  partial: boolean
}

interface AnnualChartProps {
  data: AnnualPoint[]
}

// O Recharts recebe cores como atributo SVG, que não lê variáveis CSS.
// Por isso estes valores espelham os tokens de index.css (tema escuro).
const COLOR_COMPLETE = '#f2712b' // --accent
const COLOR_PARTIAL = '#f7a03c' // --accent-2, com opacidade para o ano parcial
const COLOR_GRID = '#2a3038' // --line
const COLOR_AXIS = '#9aa1ab' // --fg-muted

export function AnnualChart({ data }: AnnualChartProps) {
  const { t, formatNumber } = useI18n()

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={COLOR_GRID} vertical={false} />
          <XAxis
            dataKey="year"
            tick={{ fill: COLOR_AXIS, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: COLOR_GRID }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: COLOR_AXIS, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => formatNumber(v)}
            width={56}
          />
          <Tooltip
            cursor={{ fill: 'rgba(242, 113, 43, 0.08)' }}
            contentStyle={{ background: '#15191e', border: `1px solid ${COLOR_GRID}`, color: '#f2efe8' }}
            labelStyle={{ color: COLOR_AXIS }}
            formatter={(value) => [formatNumber(Number(value)), t('annualAxis')]}
          />
          <Bar dataKey="total" name={t('annualAxis')} isAnimationActive={false}>
            {data.map((point) => (
              <Cell
                key={point.year}
                fill={point.partial ? COLOR_PARTIAL : COLOR_COMPLETE}
                fillOpacity={point.partial ? 0.55 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
