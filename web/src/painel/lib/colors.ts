const COUNT_STOPS = ['#1c2025', '#2e2119', '#4a2416', '#6b2a15', '#8f3115', '#b33e18', '#d9561f', '#f2712b', '#ffc46b']

const ANOMALY_STOPS = [
  { value: -100, color: '#2c7fb8' },
  { value: -50, color: '#4f9ab8' },
  { value: -20, color: '#7fb0a8' },
  { value: -5, color: '#3a4a48' },
  { value: 0, color: '#262b31' },
  { value: 25, color: '#6b2c18' },
  { value: 75, color: '#b33e18' },
  { value: 150, color: '#f2712b' },
  { value: 300, color: '#ffc46b' },
]

export const COUNT_SCALE = COUNT_STOPS
export const ANOMALY_SCALE = ANOMALY_STOPS.map((stop) => stop.color)

export function countColor(value: number, sortedPositive: number[]): string {
  if (value <= 0 || sortedPositive.length === 0) return COUNT_STOPS[0]
  let low = 0
  let high = sortedPositive.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sortedPositive[mid] < value) low = mid + 1
    else high = mid
  }
  const rank = low / sortedPositive.length
  const index = Math.min(COUNT_STOPS.length - 1, Math.max(1, Math.round(rank * (COUNT_STOPS.length - 1))))
  return COUNT_STOPS[index]
}

export function anomalyColor(value: number): string {
  const clamped = Math.max(-100, Math.min(300, value))
  for (let index = 0; index < ANOMALY_STOPS.length - 1; index++) {
    const start = ANOMALY_STOPS[index]
    const end = ANOMALY_STOPS[index + 1]
    if (clamped >= start.value && clamped <= end.value) {
      const t = (clamped - start.value) / (end.value - start.value)
      return mix(start.color, end.color, t)
    }
  }
  return ANOMALY_STOPS[ANOMALY_STOPS.length - 1].color
}

function mix(from: string, to: string, t: number): string {
  const a = hex(from)
  const b = hex(to)
  const channel = (left: number, right: number) => Math.round(left + (right - left) * t)
  return `rgb(${channel(a[0], b[0])},${channel(a[1], b[1])},${channel(a[2], b[2])})`
}

function hex(value: string): [number, number, number] {
  const h = value.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
