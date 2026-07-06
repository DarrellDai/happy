import { resolve } from 'node:path';

import { expect, test } from '@microsoft/tui-test';

test.use({
    program: {
        file: process.execPath,
        args: ['--import', 'tsx', resolve('tui/fixtures/codex-display.tsx')],
    },
});

test('switches to local mode only after the second Space press', async ({ terminal }) => {
    await expect(terminal.getByText('Codex Agent Running')).toBeVisible();

    terminal.write(' ');
    await expect(terminal.getByText('Press space again')).toBeVisible();

    terminal.write(' ');
    await expect(terminal.getByText('HAPPY_CODEX_SWITCH_TO_LOCAL', { full: true })).toBeVisible();
});
