export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function parseMonth(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  return { year, month };
}

export function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

export function compareMonth(a, b) {
  if (!a || !b) return 0;
  return monthIndex(a.year, a.month) - monthIndex(b.year, b.month);
}

export function monthFromDate(date) {
  const match = String(date ?? '').match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function monthInRange(year, month, from, to) {
  const value = monthIndex(year, month);
  if (from && value < monthIndex(from.year, from.month)) return false;
  if (to && value > monthIndex(to.year, to.month)) return false;
  return true;
}

export function monthLabel(year, month) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function todayIso() {
  return new Date().toISOString();
}
