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

export type PinView = 'rewind' | 'all';

function viewToggle(current: PinView, onView: (view: PinView) => void): HTMLElement {
  const group = document.createElement('div');
  group.className = 'view-toggle';
  group.setAttribute('role', 'group');
  for (const [view, label] of [['rewind', t.rewind], ['all', t.allView]] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = `view-${view}`;
    b.textContent = label;
    b.setAttribute('aria-pressed', String(view === current));
    b.addEventListener('click', () => view !== current && onView(view));
    group.append(b);
  }
  return group;
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

function periodsText(periods: { from: number; to: number | null }[] = []): string {
  return periods.map((p) => `${formatYear(p.from)} – ${p.to === null ? t.present : formatYear(p.to)}`).join(', ');
}

// Pin mode: every polity that ever held the place; hovering a row highlights its contour.
export function renderHistoryPanel(
  el: HTMLElement,
  features: HistoryFeature[],
  onHover: (name: string | null) => void,
  onView: (view: PinView) => void,
): void {
  el.replaceChildren();
  el.hidden = false;
  el.append(heading('h2', t.placeHistory), viewToggle('all', onView));
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

export interface RewindView {
  items: HistoryFeature[];
  index: number;
  total: number;
  loading: boolean;
  error: boolean;
  canOlder: boolean;
  canNewer: boolean;
  playing: boolean;
  sync: boolean;
}

export interface RewindHandlers {
  older: () => void;
  newer: () => void;
  goTo: (index: number) => void;
  togglePlay: () => void;
  setSync: (sync: boolean) => void;
  setView: (view: PinView) => void;
  retry: () => void;
}

function yearsText(f: HistoryFeature): string {
  const { from, to } = f.properties;
  return `${formatYear(from)} – ${to === null ? t.present : formatYear(to)}`;
}

function button(id: string, text: string, onClick: () => void, opts: { label?: string; disabled?: boolean } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.textContent = text;
  if (opts.label) b.setAttribute('aria-label', opts.label);
  b.disabled = !!opts.disabled;
  b.addEventListener('click', onClick);
  return b;
}

// Pin mode, rewind view: step back through the periods a place belonged to, newest first.
export function renderRewindPanel(el: HTMLElement, v: RewindView, h: RewindHandlers): void {
  const focused = el.contains(document.activeElement) ? document.activeElement?.id : '';
  el.replaceChildren();
  el.hidden = false;
  el.append(heading('h2', t.placeHistory), viewToggle('rewind', h.setView));

  const current = v.items[v.index];
  const controls = document.createElement('div');
  controls.className = 'rewind-controls';
  const position = document.createElement('span');
  position.id = 'rewind-position';
  position.textContent = current ? `${v.index + 1} / ${v.total}` : '…';
  controls.append(
    button('rewind-older', '◀', h.older, { label: t.older, disabled: !v.canOlder }),
    button('rewind-newer', '▶', h.newer, { label: t.newer, disabled: !v.canNewer }),
    button('rewind-play', v.playing ? t.pause : t.play, h.togglePlay, { disabled: !current }),
    position,
  );
  el.append(controls);

  if (!current && v.loading) {
    const wait = document.createElement('p');
    wait.className = 'muted';
    wait.textContent = t.loadingPeriods;
    el.append(wait);
  } else if (!current && !v.error) {
    const none = document.createElement('p');
    none.textContent = t.noData;
    el.append(none);
  }

  if (current) {
    const card = document.createElement('div');
    card.id = 'rewind-current';
    const row = approx(item(current.properties.color, polityLabel(current.properties.name)), current.properties.source);
    row.classList.add('rewind-name');
    const names = document.createElement('ul');
    names.append(row);
    const years = document.createElement('div');
    years.className = 'muted';
    years.textContent = yearsText(current);
    card.append(names, years);
    el.append(card);

    const sync = document.createElement('label');
    sync.className = 'rewind-sync';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'rewind-sync';
    box.checked = v.sync;
    box.addEventListener('change', () => h.setSync(box.checked));
    sync.append(box, ` ${t.syncYear}`);
    el.append(sync);
  }

  if (v.items.length > 0) {
    const ul = document.createElement('ul');
    ul.id = 'rewind-list';
    v.items.forEach((f, i) => {
      const li = approx(item(f.properties.color, `${polityLabel(f.properties.name)}: ${yearsText(f)}`), f.properties.source);
      if (f.properties.level > 2) li.classList.add('indent');
      if (i === v.index) {
        li.classList.add('current');
        li.setAttribute('aria-current', 'true');
      }
      li.addEventListener('click', () => h.goTo(i));
      ul.append(li);
    });
    el.append(ul);
  }

  if (v.error) {
    const err = document.createElement('p');
    err.className = 'rewind-error';
    err.append(`${t.loadMoreFailed} `, button('rewind-retry', t.retry, h.retry));
    el.append(err);
  } else if (v.loading && current) {
    const more = document.createElement('p');
    more.className = 'muted';
    more.textContent = t.loadingMore;
    el.append(more);
  }

  if (focused) (el.querySelector(`#${CSS.escape(focused)}`) as HTMLElement | null)?.focus();
}
