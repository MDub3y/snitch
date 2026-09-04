import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { BALL_COLS, BANNER_FRAMES, BANNER_WIDTH, WING_COLS, WORDMARK } from './bannerArt.js';

/** One banner frame, two-tone: wings gold, ball bright gold. */
export function BannerArt({ frame = BANNER_FRAMES.length - 1 }: { frame?: number }) {
  const rows = BANNER_FRAMES[Math.min(frame, BANNER_FRAMES.length - 1)]!;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {rows.map((row, i) => (
        <Text key={i}>
          <Text color="yellow">{row.slice(0, WING_COLS)}</Text>
          <Text color="yellowBright" bold>
            {row.slice(WING_COLS, WING_COLS + BALL_COLS)}
          </Text>
          <Text color="yellow">{row.slice(WING_COLS + BALL_COLS)}</Text>
        </Text>
      ))}
      <Text>
        {' '.repeat(Math.floor((BANNER_WIDTH - WORDMARK.length) / 2))}
        <Text color="yellowBright" bold>
          {WORDMARK}
        </Text>
      </Text>
      <Text dimColor>{' '.repeat(Math.floor((BANNER_WIDTH - 22) / 2))}terminal coding agent</Text>
    </Box>
  );
}

/** Plays the unfurl once (wrapped wings, then spreading to full span), then reports done. */
export function AnimatedBanner({ onDone }: { onDone: () => void }) {
  const [frame, setFrame] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    if (frame >= BANNER_FRAMES.length - 1) {
      if (!done.current) {
        done.current = true;
        onDone();
      }
      return;
    }
    const timer = setTimeout(() => setFrame((f) => f + 1), frame === 0 ? 350 : 110);
    return () => clearTimeout(timer);
  }, [frame, onDone]);

  return <BannerArt frame={frame} />;
}
