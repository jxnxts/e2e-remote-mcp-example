import { test, expect } from 'e2e';

test('cancellable synthetic wait', async ({ screen, app }) => {
  await app.open();
  await expect(screen.getByRole('status')).toHaveText('never arrives', { timeout: 120_000 });
});
