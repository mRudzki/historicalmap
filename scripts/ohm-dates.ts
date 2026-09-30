const DATE_RE = /^(-?\d{1,4})(?:-(\d{2}))?(?:-(\d{2}))?$/;
const CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y: number) => (isLeap(y) ? 366 : 365);
const daysInMonth = (y: number, m: number) =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const dayOfYear = (y: number, m: number, d: number) =>
  CUMULATIVE[m - 1] + d + (m > 2 && isLeap(y) ? 1 : 0); // 1-based

interface Parts { y: number; m?: number; d?: number }

function parts(s: string | undefined): Parts | null {
  const m = s ? DATE_RE.exec(s.trim()) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const month = m[2] === undefined ? undefined : Number(m[2]);
  const day = m[3] === undefined ? undefined : Number(m[3]);
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined && month !== undefined && (day < 1 || day > daysInMonth(y, month))) return null;
  return { y, m: month, d: day };
}

// Start of the period the date names, as a decimal year.
function start(s: string | undefined): number | null {
  const p = parts(s);
  if (!p) return null;
  if (p.m === undefined) return p.y;
  return p.y + (dayOfYear(p.y, p.m, p.d ?? 1) - 1) / daysInYear(p.y);
}

// End of the period the date names (exclusive), as a decimal year.
function end(s: string | undefined): number | null {
  const p = parts(s);
  if (!p) return null;
  if (p.m === undefined) return p.y + 1;
  return p.y + dayOfYear(p.y, p.m, p.d ?? daysInMonth(p.y, p.m)) / daysInYear(p.y);
}

export function parseOhmInterval(
  startDate: string | undefined,
  endDate: string | undefined,
): { from: number; to: number | null } | null {
  const from = start(startDate);
  if (from === null) return null;
  if (endDate === undefined || endDate === '') return { from, to: null };
  const to = end(endDate);
  if (to === null || to <= from) return null;
  return { from, to };
}

// Features tagged with a share-alike licence are not imported (see the design spec).
export function isShareAlike(license: string | undefined): boolean {
  return !!license && /(^|[^a-z])sa([^a-z]|$)|share-?alike/i.test(license);
}
