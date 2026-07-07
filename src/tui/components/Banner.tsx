/**
 * Banner — the "SophronSwarm" ASCII-art header for the shell.
 *
 * Compact figlet-style banner that sits at the top of the box chrome, above the
 * horizontal divider and the tab bar.
 */
import React from "react";
import { Box, Text } from "ink";

// Compact 5-line ASCII art for "SophronSwarm".
const BANNER = [
  "  ____                  _                       _              ",
  " / ___|  ___  ___ _ __ | |__   ___ _ __ _ __ ___| |_ ___  _ __  ",
  " \\___ \\ / _ \\/ __| '_ \\| '_ \\ / _ \\ '__| '__/ _ \\ __/ _ \\| '__| ",
  "  ___) |  __/\\__ \\ |_) | | | |  __/ |  | | |  __/ || (_) | |    ",
  " |____/ \\___||___/ .__/|_| |_|\\___|_|  |_|  \\___|\\__\\___/|_|    ",
  "                 |_|                                            ",
];

export function Banner({ version }: { version?: string }) {
  return (
    <Box flexDirection="column">
      {BANNER.map((line, i) => (
        <Text key={i} color="cyan">
          {line}
        </Text>
      ))}
      {version ? (
        <Text dimColor>{"  " + version}</Text>
      ) : null}
    </Box>
  );
}
