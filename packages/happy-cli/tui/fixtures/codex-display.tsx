import React from 'react';
import { render } from 'ink';

import { CodexDisplay } from '../../src/ui/ink/CodexDisplay';
import { MessageBuffer } from '../../src/ui/ink/messageBuffer';

const messageBuffer = new MessageBuffer();
let app: ReturnType<typeof render>;

app = render(
    <CodexDisplay
        messageBuffer={messageBuffer}
        onSwitchToLocal={() => {
            app.unmount();
            process.stdout.write('\nHAPPY_CODEX_SWITCH_TO_LOCAL\n');
            setTimeout(() => process.exit(0), 25);
        }}
    />,
    {
        exitOnCtrlC: false,
        patchConsole: false,
    },
);
