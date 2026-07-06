import { defineConfig } from '@microsoft/tui-test';

export default defineConfig({
    testMatch: '**/tui/**/*.tui.test.ts',
    workers: 1,
    use: {
        columns: 100,
        rows: 24,
    },
});
