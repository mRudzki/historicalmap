import { expect, test } from '@playwright/test';

test('click shows the polity, slider changes the year', async ({ page }) => {
  await page.goto('/?lat=45&lng=2&zoom=5');
  const slider = page.locator('#slider');
  await expect(page.locator('#year-label')).toHaveText('1100');

  // Tiles must actually render (a dead worker still lets the API-backed panel work)
  await page.waitForFunction(
    () => (window as any).__map.queryRenderedFeatures({ layers: ['polity-fill'] }).length > 0,
  );

  const canvas = page.locator('#map canvas');
  const box = (await canvas.boundingBox())!;
  const center = { x: box.width / 2, y: box.height / 2 };

  // 1100: lon 2 is inside Kingdom B (0..8)
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Kingdom B');

  // 1000: lon 2 is inside Kingdom A only
  await slider.fill('0');
  await expect(page.locator('#year-label')).toHaveText('1000');
  await canvas.click({ position: center });
  await expect(page.locator('#panel')).toContainText('Kingdom A');
});
