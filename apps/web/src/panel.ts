import type { AtResponse, Period } from './api';
import { formatYear, polityLabel } from './format';

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

export function renderPanel(el: HTMLElement, at: AtResponse, periods: Period[]): void {
  el.replaceChildren();
  el.hidden = false;

  el.append(heading('h2', `W roku ${formatYear(at.year)}`));
  if (at.snapshotYear !== null && at.snapshotYear !== at.year) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = `Najbliższa dostępna mapa: ${formatYear(at.snapshotYear)}`;
    el.append(note);
  }
  if (at.polities.length === 0) {
    const none = document.createElement('p');
    none.textContent = 'Brak danych dla tego miejsca w tym roku.';
    el.append(none);
  } else {
    const ul = document.createElement('ul');
    for (const p of at.polities) ul.append(item(p.color, polityLabel(p.name)));
    el.append(ul);
  }

  el.append(heading('h3', 'Historia tego miejsca'));
  const ul = document.createElement('ul');
  for (const p of periods) {
    const to = p.to === null ? 'dziś' : formatYear(p.to);
    ul.append(item(p.color, `${polityLabel(p.name)}: ${formatYear(p.from)} – ${to}`));
  }
  el.append(ul);
}
