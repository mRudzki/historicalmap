import type { AtResponse, HistoryFeature, Period, PolityAt } from './api';
import { formatYear, polityLabel } from './format';
import { t } from './strings';

function item(color: string, text: string): HTMLLIElement {
  const li = document.createElement('li');
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = color;
  const label = document.createElement('span');
  label.textContent = text;
  li.append(swatch, label);
  return li;
}

function heading(tag: 'h2' | 'h3', text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function approx(li: HTMLLIElement, source: 'ohm' | 'hb'): HTMLLIElement {
  if (source === 'hb') {
    const note = document.createElement('span');
    note.className = 'approx';
    note.textContent = t.approximate;
    li.append(note);
  }
  return li;
}

function polityItem(p: PolityAt, indent: boolean): HTMLLIElement {
  const li = approx(item(p.color, polityLabel(p.name)), p.source);
  if (indent) li.classList.add('indent');
  return li;
}

export function renderPanel(el: HTMLElement, at: AtResponse, periods: Period[], showRegions: boolean): void {
  el.replaceChildren();
  el.hidden = false;

  el.append(heading('h2', t.inYear(formatYear(at.year))));
  if (at.polities.length === 0) {
    const none = document.createElement('p');
    none.textContent = t.noDataYear;
    el.append(none);
  } else {
    const ul = document.createElement('ul');
    for (const p of at.polities) ul.append(polityItem(p, false));
    if (showRegions) for (const r of at.regions) ul.append(polityItem(r, true));
    el.append(ul);
  }

  el.append(heading('h3', t.placeHistory));
  const ul = document.createElement('ul');
  for (const p of periods) {
    const to = p.to === null ? t.present : formatYear(p.to);
    ul.append(approx(item(p.color, `${polityLabel(p.name)}: ${formatYear(p.from)} – ${to}`), p.source));
  }
  el.append(ul);
}

function periodsText(periods: { from: number; to: number | null }[]): string {
  return periods.map((p) => `${formatYear(p.from)} – ${p.to === null ? t.present : formatYear(p.to)}`).join(', ');
}

// Pin mode: every polity that ever held the place; hovering a row highlights its contour.
export function renderHistoryPanel(
  el: HTMLElement,
  features: HistoryFeature[],
  onHover: (name: string | null) => void,
): void {
  el.replaceChildren();
  el.hidden = false;
  el.append(heading('h2', t.placeHistory));
  if (features.length === 0) {
    const none = document.createElement('p');
    none.textContent = t.noData;
    el.append(none);
    return;
  }
  const ul = document.createElement('ul');
  for (const f of features) {
    const li = approx(
      item(f.properties.color, `${polityLabel(f.properties.name)}: ${periodsText(f.properties.periods)}`),
      f.properties.source,
    );
    if (f.properties.level > 2) li.classList.add('indent');
    li.dataset.name = f.properties.name;
    li.addEventListener('mouseenter', () => onHover(f.properties.name));
    li.addEventListener('mouseleave', () => onHover(null));
    ul.append(li);
  }
  el.append(ul);
}
