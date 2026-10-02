import { expect, test } from '@playwright/test';
import { closeConnections, getDatabase } from '@portfolio-pilot/db';

test('grounded chat persists citations and rejects another authenticated user', async ({ page, browser }) => {
  test.setTimeout(90000);
  const url = process.env.CHAT_E2E_DATABASE_URL;
  test.skip(!url, 'Set CHAT_E2E_DATABASE_URL and run the API against portfolio_m18_verify.');
  const target = new URL(url!);
  if (target.hostname !== '127.0.0.1' || target.pathname !== '/portfolio_m18_verify') throw new Error('Use the dedicated loopback chat database.');
  const db = await getDatabase(url!);
  const run = `chat-ui-${crypto.randomUUID().slice(0, 8)}`;
  const bob = await browser.newContext();
  let conversationId = '';
  try {
    await db.security.create({ data: { id: run, symbol: `C${run.slice(-8).toUpperCase()}`, exchangeMic: 'XNAS', name: 'Fictional chat fixture', currency: 'USD' } });
    await db.quoteSnapshot.create({ data: { securityId: run, price: '125', currency: 'USD', provider: 'chat-ui', asOf: new Date(), isSynthetic: true } });
    await db.portfolio.create({ data: { id: run, ownerId: 'demo-alice', name: run, transactions: { create: { securityId: run, side: 'BUY', quantity: '9', price: '100', fees: '0', amount: '900', occurredAt: new Date('2025-01-01T00:00:00Z') } } } });
    await db.newsArticle.create({ data: { id: `${run}-news`, provider: 'chat-ui', providerArticleId: run, title: 'Fictional product review scheduled', summary: 'Synthetic reporting for browser acceptance.', url: `https://example.invalid/${run}`, publishedAt: new Date(), isSynthetic: true, securities: { create: [{ securityId: run }] } } });
    await page.goto('/assistant');
    await page.getByRole('button', { name: 'Sign in as Alice Demo' }).click();
    await page.getByLabel('Scope for new conversation').selectOption(run);
    // Earlier conversations may already be selected; wait for the one this click creates.
    const created = page.waitForResponse(r => r.url().endsWith('/api/conversations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'New conversation' }).click();
    conversationId = (await (await created).json()).conversation.id;
    await expect(page.getByLabel('Conversation', { exact: true })).toHaveValue(conversationId);
    expect(await db.conversation.count({ where: { id: conversationId, portfolioId: run } })).toBe(1);
    await page.getByLabel('Ask about your portfolio').fill('Which recent news affects my largest holding?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Assistant · MOCK', { exact: true })).toBeVisible();
    await expect(page.getByText('Your largest holding by current USD market value', { exact: false }).first()).toContainText('1125.00 USD');
    const link = page.getByRole('link', { name: `${run}-news`, exact: true }).first();
    await expect(link).toHaveAttribute('href', `https://example.invalid/${run}`);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await page.reload();
    await page.getByLabel('Conversation', { exact: true }).selectOption(conversationId);
    await expect(page.getByText('Assistant · MOCK', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/grounded-chat-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    await page.screenshot({ path: 'test-results/grounded-chat-mobile.png', fullPage: true });
    const bobPage = await bob.newPage();
    await bobPage.goto('/assistant'); await bobPage.getByRole('button', { name: 'Sign in as Bob Demo' }).click();
    await expect(bobPage.getByRole('heading', { name: 'Assistant', exact: true })).toBeVisible();
    expect((await bob.request.get(`/api/conversations/${conversationId}/messages`)).status()).toBe(404);
    expect((await bob.request.post(`/api/conversations/${conversationId}/messages`, { data: { content: 'news' }, headers: { origin: 'http://127.0.0.1:5173' } })).status()).toBe(404);
    expect((await page.request.post('/api/demo/ask', { data: { question: 'news' } })).status()).toBe(404);
  } finally {
    await db.conversation.deleteMany({ where: { OR: [{ portfolioId: run }, ...(conversationId ? [{ id: conversationId }] : [])] } });
    await db.newsArticle.deleteMany({ where: { id: `${run}-news` } });
    await db.portfolio.deleteMany({ where: { id: run } });
    await db.security.deleteMany({ where: { id: run } });
    await bob.close(); await closeConnections();
  }
});
