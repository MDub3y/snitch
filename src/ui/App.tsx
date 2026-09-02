import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

export function App() {
  const { exit } = useApp();
  const [lastKey, setLastKey] = useState<string | null>(null);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    setLastKey(key.return ? '<enter>' : key.escape ? '<esc>' : input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        ⚡ Snitch
      </Text>
      <Text dimColor>mini terminal coding agent — phase 1 scaffold</Text>
      <Box marginTop={1}>
        <Text>
          last key: <Text color="cyan">{lastKey ?? '(none yet)'}</Text>
        </Text>
      </Box>
      <Text dimColor>press q or ctrl+c to exit</Text>
    </Box>
  );
}
