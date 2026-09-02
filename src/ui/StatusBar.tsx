import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { UsageTotals } from '../agent/loop.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Props {
  model: string;
  mode: 'input' | 'working' | 'approval';
  totals: UsageTotals;
  status: string | null;
}

export function StatusBar({ model, mode, totals, status }: Props) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (mode !== 'working') return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [mode]);

  return (
    <Box justifyContent="space-between">
      <Text dimColor>
        {mode === 'working' ? `${FRAMES[frame]} working` : mode === 'approval' ? '⏸ awaiting approval' : '· ready'}
        {status ? `  ${status}` : ''}
        {'  '}
        <Text dimColor>esc to cancel</Text>
      </Text>
      <Text dimColor>
        {model} · {totals.promptTokens + totals.completionTokens} tok
        {totals.cost > 0 ? ` · $${totals.cost.toFixed(5)}` : ''}
      </Text>
    </Box>
  );
}
