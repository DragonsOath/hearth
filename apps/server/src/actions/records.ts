import { ACTIONS, type ActionKind, type ActionRecord } from "@dragon-control/core";
import type * as t from "../db/schema";

type ActionRow = typeof t.actions.$inferSelect;

export function toActionRecord(row: ActionRow, serviceName: string): ActionRecord {
  const kind = row.kind as ActionKind;
  return {
    id: row.id,
    kind,
    label: ACTIONS[kind]?.describe(serviceName) ?? row.kind,
    serviceId: row.targetId,
    incidentId: row.incidentId ?? undefined,
    requestedBy: row.requestedBy,
    status: row.status,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt ?? undefined,
    result: row.result ?? undefined,
  };
}
