import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  active: boolean;
  onSubmit: (value: string) => void;
  placeholder?: string;
}

export function InputBox({ active, onSubmit, placeholder = 'describe a task…' }: Props) {
  const [value, setValue] = useState('');

  useInput(
    (input, key) => {
      if (key.return) {
        const trimmed = value.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setValue('');
        }
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        setValue((v) => v + input);
      }
    },
    { isActive: active },
  );

  return (
    <Box>
      <Text color="green" bold>
        {'> '}
      </Text>
      <Text>{value}</Text>
      {active ? <Text inverse> </Text> : null}
      {!value && active ? <Text dimColor>{placeholder}</Text> : null}
    </Box>
  );
}
