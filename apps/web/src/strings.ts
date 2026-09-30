// All user-facing text lives here (one place to change or translate).
export const t = {
  title: 'History of Europe on a map',
  year: 'Year',
  pin: 'Pin',
  mode: 'Mode',
  present: 'present',
  approximate: '(approximate)',
  lackOfData: 'Lack of data',
  bc: 'BC',
  inYear: (year: string) => `In ${year}`,
  closestMap: (year: string) => `Closest available map: ${year}`,
  noDataYear: 'No data for this place in this year.',
  noData: 'No data for this place.',
  placeHistory: 'History of this place',
  noImportedData: 'no data — run the import',
  serverUnreachable: 'Could not reach the server. Retrying…',
  loadFailed: 'Could not load data. Try clicking again.',
};
