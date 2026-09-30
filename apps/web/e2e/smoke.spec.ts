import { expect, test } from '@playwright/test';

const thisYear = String(new Date().getFullYear());
const setYear = async (page: import('@playwright/test').Page, y: string) => {
  await page.locator('#year-input').fill(y);
  await page.locator('#year-input').press('Enter');
  await expect(page.locator('#year-label')).toHaveText(y);
};

test('click shows the polity, the year input changes the year', async ({ page }) => {
  await page.goto('/?lat=45&lng=2&zoom=5');
  await expect(page.locator('#year-label')).toHaveText(thisYear);

  // Tiles must actually render (a dead worker still lets the API-backed panel work)
  await page.waitForFunction(
    () => (window as any).__map.queryRenderedFeatures({ layers: ['fallback-fill', 'polity-fill'] }).length > 0,
  );

  const canvas = page.locator('#map canvas');
  const box = (await canvas.boundingBox())!;
  const center = { x: box.width / 2, y: box.height / 2 };

  // now: lon 2 is inside Kingdom B (HB, open-ended, lon 0..8)
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Kingdom B');

  // 1000: lon 2 is inside Kingdom A only
  await setYear(page, '1000');
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Kingdom A');
});

test('shows a message instead of a blank page when the API is down', async ({ page }) => {
  await page.route('**/range', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#year-label')).toContainText('Could not reach the server');
});

test('recovers by itself when the API comes back after a failed start', async ({ page }) => {
  let calls = 0;
  await page.route('**/range', (route) => (calls++ < 2 ? route.abort() : route.continue()));
  await page.goto('/');
  await expect(page.locator('#year-label')).toContainText('Could not reach the server');
  await expect(page.locator('#year-label')).toHaveText(thisYear, { timeout: 20000 });
  await page.waitForFunction(() => (window as any).__map);
});

test('HB border lines are drawn below the opaque OHM fill', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__map?.getStyle().layers.length);
  const order: string[] = await page.evaluate(() =>
    (window as any).__map.getStyle().layers.map((l: { id: string }) => l.id),
  );
  const at = (id: string) => order.indexOf(id);
  expect(at('fallback-fill')).toBeLessThan(at('fallback-line-precise'));
  expect(at('fallback-line-precise')).toBeLessThan(at('polity-fill'));
  expect(at('fallback-line-approx')).toBeLessThan(at('polity-fill'));
  expect(at('polity-fill')).toBeLessThan(at('polities-line-precise'));
});

test('the Regions checkbox works in pin mode too', async ({ page }) => {
  await page.goto('/?lat=44&lng=2&zoom=5');
  await page.getByRole('button', { name: 'Pin' }).click();
  await expect(page.locator('#regions')).toBeVisible();

  const canvas = page.locator('#map canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator('#panel')).toContainText('Realm X');
  await expect(page.locator('#panel')).not.toContainText('Region R');

  await page.locator('#regions').check(); // refetches the history of the pinned place
  await expect(page.locator('#panel')).toContainText('Region R');
  await page.locator('#regions').uncheck();
  await expect(page.locator('#panel')).not.toContainText('Region R');
});

test('pin mode: coordinates can be typed, and clicking the map fills them in', async ({ page }) => {
  await page.goto('/?lat=44&lng=2&zoom=3');
  await expect(page.locator('#coords')).toBeHidden();
  await page.getByRole('button', { name: 'Pin' }).click();
  await expect(page.locator('#coords')).toBeVisible();

  const input = page.locator('#coords-input');
  await input.fill('44, 2');
  await input.press('Enter');
  await expect(page.locator('.maplibregl-marker')).toBeVisible();
  await expect(page.locator('#panel')).toContainText('Realm X');
  await expect(page.locator('#coords-error')).toBeHidden();

  await input.fill('not coordinates');
  await input.press('Enter');
  await expect(page.locator('#coords-error')).toContainText('Enter coordinates like');
  await expect(page.locator('#panel')).toContainText('Realm X'); // nothing changed

  // the map was flown to the place; a click next to the pin writes that position into the field
  await expect.poll(() => page.evaluate(() => (window as any).__map.getZoom())).toBeGreaterThanOrEqual(5);
  await page.waitForTimeout(1500);
  const canvas = page.locator('#map canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2 + 40, y: box.height / 2 } }); // the pin itself covers the centre
  await expect(input).toHaveValue(/^4[34]\.\d{4}, [1-4]\.\d{4}$/);
  await expect(page.locator('#coords-error')).toBeHidden();
});

test('pin mode drops a pin and outlines every polity that ever held the place', async ({ page }) => {
  await page.goto('/?lat=45&lng=7&zoom=5');
  await page.waitForFunction(
    () => (window as any).__map.queryRenderedFeatures({ layers: ['fallback-fill', 'polity-fill'] }).length > 0,
  );
  await page.getByRole('button', { name: 'Pin' }).click();
  await expect(page.locator('#slider')).toBeHidden();

  const canvas = page.locator('#map canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });

  await expect(page.locator('.maplibregl-marker')).toBeVisible();
  await page.waitForFunction(
    () => (window as any).__map.queryRenderedFeatures({ layers: ['history-line'] }).length > 0,
  );
  await expect(page.locator('#panel')).toContainText('Kingdom A');
  await expect(page.locator('#panel')).toContainText('Kingdom B');

  await page.getByRole('button', { name: 'Year' }).click();
  await expect(page.locator('.maplibregl-marker')).toHaveCount(0);
  await expect(page.locator('#slider')).toBeVisible();
});

test('OHM data wins, HB fills gaps and is marked approximate, regions are optional', async ({ page }) => {
  await page.goto('/?lat=44&lng=2&zoom=5');
  const canvas = page.locator('#map canvas');
  const box = (await canvas.boundingBox())!;
  const center = { x: box.width / 2, y: box.height / 2 };

  await setYear(page, '1060');
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Realm X');
  await expect(page.locator('#panel')).not.toContainText('Region R');

  await page.locator('#regions').check();
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Region R');

  await setYear(page, '1090');
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Kingdom A');
  await expect(page.locator('#panel')).toContainText('(approximate)');
});

test('typing an invalid year keeps the map working', async ({ page }) => {
  await page.goto('/');
  await page.locator('#year-input').fill('99999');
  await page.locator('#year-input').press('Enter');
  await expect(page.locator('#year-label')).toHaveText(thisYear);
  await page.locator('#year-input').fill(''); // a number input cannot hold letters; empty is the invalid case
  await page.locator('#year-input').press('Enter');
  await expect(page.locator('#year-label')).toHaveText(thisYear);
  await expect(page.locator('#map canvas')).toBeVisible();
});

test('legal pages are linked from the map and identify the operator', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/mRudzki/historicalmap',
  );

  await expect(page.getByRole('link', { name: 'About the author' })).toHaveAttribute('href', '/legal.html#about');

  await page.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy');
  const main = page.locator('main');
  await expect(main).toContainText('Michał Rudzki');
  await expect(main).toContainText('6452571170');
  await expect(main).toContainText('does not use cookies');
  await expect(main).toContainText('does not show advertising');
  await expect(main).not.toContainText('If advertising or analytics are added');

  await page.getByRole('link', { name: 'Legal notice' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Legal Notice');
  await expect(main).toContainText('GPL-3.0');
  await expect(main).toContainText('OpenHistoricalMap');
  await expect(main).toContainText('CC0');
  await expect(main).toContainText('free of charge');
  await expect(main).toContainText('no advertising');
  await expect(main).toContainText('Natural Earth');

  // about the author: hobby project, personal profiles and the business site for doctors
  const about = page.locator('#about');
  await expect(about).toContainText('hobby project');
  await expect(about.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/mRudzki');
  await expect(about.getByRole('link', { name: 'LinkedIn' })).toHaveAttribute('href', /^https:\/\/www\.linkedin\.com\/in\//);
  await expect(about.getByRole('link', { name: 'mediqcare.pl' })).toHaveAttribute('href', 'https://mediqcare.pl');
  await expect(about).toContainText('doctors');
  await expect(main).toContainText('Historical Basemaps');

  await page.getByRole('link', { name: 'Back to the map' }).click();
  await expect(page.locator('#map')).toBeVisible();
});
