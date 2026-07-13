/**
 * MessageThread — shared activity rendering for chat-style surfaces.
 *
 * Used by OrchestratorChat and ChannelView so message/event styling never
 * diverges (Invariant I3).
 */
import React from "react";
import { Box, Text } from "ink";

export interface UserItem {
  id: string | number;
  kind: "user";
  text: string;
}

export interface AgentItem {
  id: string | number;
  kind: "agent";
  agentName: string;
  text: string;
}

export interface EventItem {
  id: string | number;
  kind: "event";
  text: string;
  turn?: number;
  color?: string;
}

export type ActivityItem = UserItem | AgentItem | EventItem;

export interface MessageThreadProps {
  items: ActivityItem[];
  emptyHint?: string;
}

export function MessageThread({ items, emptyHint }: MessageThreadProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {items.length === 0 && emptyHint ? (
        <Box marginBottom={1}>
          <Text dimColor>{`  ${emptyHint}`}</Text>
        </Box>
      ) : null}
      {items.map((item) => (
        <MessageRow key={item.id} item={item} />
      ))}
    </Box>
  );
}

function MessageRow({ item }: { item: ActivityItem }) {
  const { prefix, color } = formatItem(item);
  const lines = item.text.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={i === 0 ? color : undefined}>
          {i === 0 ? `${prefix}${line}` : `      ${line}`}
        </Text>
      ))}
    </Box>
  );
}

function formatItem(item: ActivityItem): { prefix: string; color: string } {
  switch (item.kind) {
    case "user":
      return { prefix: "  you › ", color: "green" };
    case "agent":
      return { prefix: `  🤖 ${item.agentName} › `, color: "cyan" };
    case "event":
      return { prefix: `  ${item.turn !== undefined ? `t${item.turn} ` : "   "}› `, color: item.color ?? "gray" };
  }
}
