export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function sum(values) {
  return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
}

export function mean(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return null;
  return sum(valid) / valid.length;
}

export function median(values) {
  const valid = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const middle = Math.floor(valid.length / 2);
  if (valid.length % 2 === 1) return valid[middle];
  return (valid[middle - 1] + valid[middle]) / 2;
}

export function quantile(values, probability) {
  const valid = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  const position = (valid.length - 1) * clamp(probability, 0, 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return valid[lower];
  const weight = position - lower;
  return valid[lower] * (1 - weight) + valid[upper] * weight;
}

export function linearRegressionSlope(xs, ys) {
  const points = xs
    .map((x, index) => [Number(x), Number(ys[index])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length < 2) return null;
  const meanX = mean(points.map(([x]) => x));
  const meanY = mean(points.map(([, y]) => y));
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMedianCI(values, { resamples = 200, seed = 20261114 } = {}) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return { low: null, high: null, median: null, uncertaintyPct: 100 };
  if (valid.length < 3) {
    const value = median(valid);
    return { low: value, high: value, median: value, uncertaintyPct: 100 };
  }

  const random = mulberry32(seed);
  const medians = [];
  for (let i = 0; i < resamples; i += 1) {
    const sample = [];
    for (let j = 0; j < valid.length; j += 1) {
      sample.push(valid[Math.floor(random() * valid.length)]);
    }
    medians.push(median(sample));
  }
  medians.sort((a, b) => a - b);
  const low = quantile(medians, 0.025);
  const high = quantile(medians, 0.975);
  const center = median(valid);
  const uncertaintyPct = center > 0 ? clamp((((high - low) / 2) / center) * 100, 0, 100) : 100;
  return { low, high, median: center, uncertaintyPct };
}

export function round(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function percentileRange(values) {
  return {
    p05: quantile(values, 0.05),
    p95: quantile(values, 0.95),
  };
}
