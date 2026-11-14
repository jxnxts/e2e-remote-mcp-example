import { test, expect } from 'e2e';

test('synthetic citizen request', async ({ screen, app }) => {
  await app.open();
  await screen.getByRole('textbox', { name: 'Request' }).fill('Street light 42');
  await screen.getByRole('button', { name: 'Submit' }).tap();
  await expect(screen.getByRole('status')).toHaveText('Received: Street light 42');
  await app.screenshot('submitted');
});
