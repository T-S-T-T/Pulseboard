/** Phase 1 "done when": a stranger can sign up and see a failed check. */
import { expect, test, type Page } from '@playwright/test';

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'correct horse battery';

async function createAccount(page: Page, name: string) {
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(`${unique()}@example.com`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('sign up, see a failed check, publish it and invite a teammate', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await createAccount(page, 'Sam Stranger');

  await page.getByLabel('New team name').fill('Demo Team');
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('heading', { name: 'Demo Team' })).toBeVisible();

  // Private targets are refused.
  await page.getByLabel('Service name').fill('Metadata');
  await page.getByLabel('URL to check').fill('http://169.254.169.254/');
  await page.getByRole('button', { name: 'Add service' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Address is not public' })).toBeVisible();

  // .invalid never resolves, so this check fails without needing the internet.
  await page.getByLabel('Service name').fill('Broken API');
  await page.getByLabel('URL to check').fill('https://pulseboard-demo.invalid/health');
  await page.getByLabel('Show on the public status page').check();
  await page.getByRole('button', { name: 'Add service' }).click();

  const card = page.getByRole('listitem', { name: 'Broken API' });
  await expect(card.getByText('Down', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(card).toContainText('DNS lookup failed');
  // One failure is not yet an incident.
  await expect(page.getByRole('region', { name: 'Incidents' })).toContainText('No incidents');

  await page.getByLabel('Publish the status page').click();
  const link = page.getByRole('link', { name: 'View status page' });
  const statusPath = await link.getAttribute('href');

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(statusPath!);
  await expect(visitor.getByRole('status')).toHaveText('Some services are down');
  await expect(visitor.getByText('pulseboard-demo.invalid')).toHaveCount(0);

  // Invite: a signed-out teammate signs up and lands back on the invite.
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const inviteUrl = await page.getByLabel(/Send this link/).inputValue();
  await visitor.goto(inviteUrl);
  await visitor.getByRole('button', { name: 'Create a new account' }).click();
  await createAccount(visitor, 'Tess Teammate');
  await visitor.getByRole('button', { name: 'Accept invite' }).click();
  await expect(visitor.getByRole('heading', { name: 'Demo Team' })).toBeVisible();
  await expect(visitor.getByRole('button', { name: 'Add service' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Pulseboard' })).toBeVisible();
});
