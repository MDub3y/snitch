import React from 'react';
import { Box, Static, Text } from 'ink';

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; summary: string; status: 'ok' | 'denied' | 'error' }
  | { kind: 'info'; text: string };

export function ItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="green" bold>
            {'❯ '}
          </Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'tool': {
      const badge = item.status === 'ok' ? '✓' : item.status === 'denied' ? '✗ denied' : '✗ error';
      const color = item.status === 'ok' ? 'yellow' : 'red';
      return (
        <Box paddingLeft={2}>
          <Text color={color}>
            ⚙ {item.name} {badge}
          </Text>
          <Text dimColor> {item.summary}</Text>
        </Box>
      );
    }
    case 'info':
      return (
        <Box paddingLeft={2}>
          <Text dimColor italic>
            {item.text}
          </Text>
        </Box>
      );
  }
}

/** Finished items go through <Static> so Ink never re-renders them (flicker-free). */
export function Transcript({ items }: { items: TranscriptItem[] }) {
  return <Static items={items}>{(item, index) => <ItemView key={index} item={item} />}</Static>;
}
