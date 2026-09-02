import React from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  name: string;
  /** Preview text when approval is pending, otherwise the raw args. */
  detail: string;
  awaitingApproval: boolean;
  onDecision: (approved: boolean) => void;
}

export function ToolCallCard({ name, detail, awaitingApproval, onDecision }: Props) {
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') onDecision(true);
      else if (input === 'n' || input === 'N' || key.escape) onDecision(false);
    },
    { isActive: awaitingApproval },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={awaitingApproval ? 'yellow' : 'gray'}
      paddingX={1}
      marginTop={1}
    >
      <Text color="yellow" bold>
        ⚙ {name}
      </Text>
      <Text>{detail}</Text>
      {awaitingApproval ? (
        <Text bold color="yellow">
          approve? [y]es / [n]o
        </Text>
      ) : (
        <Text dimColor>running…</Text>
      )}
    </Box>
  );
}
