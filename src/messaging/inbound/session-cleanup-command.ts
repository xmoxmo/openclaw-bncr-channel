import { parseStrictBncrSessionKey } from '../../core/targets.ts';
import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';
import type { NativeCommand } from './native-command.ts';
import { BNCR_SESSION_NAME_MAX_CHARS, formatBncrSceneLabel } from './session-identity.ts';

/**
 * A bncr chat session quiet this long is a cleanup candidate by default.
 *
 * Thirty days is safe because a session that goes 72h without traffic is reset
 * anyway: nothing here can lose a conversation that was still warm.
 */
export const BNCR_SESSION_CLEANUP_DEFAULT_DAYS = 30;

/** Typed day counts stay inside a range an operator can reason about. */
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One chat message cannot carry an unbounded list, and neither can one sweep. */
export const BNCR_SESSION_CLEANUP_MAX_BATCH = 50;

export type SessionCleanupCommand =
  | { action: 'list'; days: number }
  | { action: 'prune'; days: number }
  | { action: 'help' };

export type ParsedSessionCleanupCommand =
  | { matched: false }
  | { matched: true; valid: false; text: string }
  | { matched: true; valid: true; command: SessionCleanupCommand };

const SESSION_USAGE_TEXT = [
  'Usage:',
  '  /bncr sessions help',
  '  /bncr sessions [<days>]',
  '  /bncr sessions prune [<days>]',
].join('\n');

export const SESSION_CLEANUP_HELP_TEXT = [
  '🧹 Bncr sessions',
  '',
  'About:',
  '  • 只清宿主会话表：列出并删除静默超过 <days> 天的 bncr 会话（缺省 ' +
    String(BNCR_SESSION_CLEANUP_DEFAULT_DAYS) +
    ' 天）。',
  '  • 场景行已经没了的孤儿会话也在其中，场景命令看不到它们。',
  '  • 只删会话条目，场景行（准入、mode、名字、分组）都保留，下一条消息会重建会话。',
  '  • 每次最多处理 ' + String(BNCR_SESSION_CLEANUP_MAX_BATCH) + ' 个会话，剩下的再跑一次。',
  '  • 列出和删除之间又有消息进来的会话会跳过，并单独报出来。',
  '  • 其它频道的会话一律不碰。',
  '  • 仅管理员可用。',
  '',
  'Commands:',
  '  • /bncr sessions [<days>]',
  '    列出静默至少 <days> 的会话，最老的先来；带可读标签、归属 agent，以及场景行是否还在。',
  '  • /bncr sessions prune [<days>]',
  '    删除同一批：只删会话条目，聊天记录归档到磁盘；场景行保留，下一条消息重建会话，准入不受影响。',
  '',
  'Format:',
  '  • <days> — 缺省 ' +
    String(BNCR_SESSION_CLEANUP_DEFAULT_DAYS) +
    '，可填 ' +
    String(MIN_DAYS) +
    '-' +
    String(MAX_DAYS),
].join('\n');

function splitArgs(raw: string): string[] {
  return String(raw ?? '')
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseDays(raw: string | undefined, fallback: number): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < MIN_DAYS || value > MAX_DAYS) return null;
  return Math.floor(value);
}

export function parseSessionCleanupCommand(command: NativeCommand): ParsedSessionCleanupCommand {
  if (
    String(command.command ?? '')
      .trim()
      .toLowerCase() !== 'sessions'
  ) {
    return { matched: false };
  }
  const args = splitArgs(command.argsText);
  if (args.length === 1 && args[0].toLowerCase() === 'help') {
    return { matched: true, valid: true, command: { action: 'help' } };
  }
  if (args.length > 2) return { matched: true, valid: false, text: SESSION_USAGE_TEXT };

  if (args.length > 0 && args[0].toLowerCase() === 'prune') {
    const days = parseDays(args[1], BNCR_SESSION_CLEANUP_DEFAULT_DAYS);
    if (days == null) return { matched: true, valid: false, text: SESSION_USAGE_TEXT };
    return { matched: true, valid: true, command: { action: 'prune', days } };
  }

  // A bare listing takes at most one day count; anything longer is a typo, not
  // a silently narrower sweep.
  if (args.length > 1) return { matched: true, valid: false, text: SESSION_USAGE_TEXT };
  const days = parseDays(args[0], BNCR_SESSION_CLEANUP_DEFAULT_DAYS);
  if (days == null) return { matched: true, valid: false, text: SESSION_USAGE_TEXT };
  return { matched: true, valid: true, command: { action: 'list', days } };
}

/** One host session row, already reduced to the fields cleanup needs. */
export type BncrSessionActivity = {
  sessionKey: string;
  /**
   * Last chat activity. Falls back to the store write time, which only means
   * "something wrote this row" — a label patch or a meta refresh, not a message.
   */
  lastActivityAt: number | null;
  /** False when `lastActivityAt` is really just the store write time. */
  hasInteractionAt?: boolean;
  /** Set when the operator archived this session from the UI. */
  archivedAt: number | null;
};

export type SessionCleanupDeps = {
  now: () => number;
  /** Every agent whose store should be read: configured + bound + serving. */
  agentIds: readonly string[];
  /** `undefined` means the store for that agent could not be read. */
  listSessions: (agentId: string) => Promise<readonly BncrSessionActivity[] | undefined>;
  /** Fresh read of one entry, used to re-check freshness right before deleting. */
  readSession?: (args: {
    agentId: string;
    sessionKey: string;
  }) => Promise<BncrSessionActivity | undefined>;
  sceneRegistry: ReadonlyMap<string, BncrSceneRecord>;
  deleteSession: (args: {
    agentId: string;
    sessionKey: string;
    archiveTranscript?: boolean;
  }) => Promise<boolean>;
};

export type SessionCleanupRow = {
  agentId: string;
  sessionKey: string;
  /** `platform:id`, the bncr scene identity behind this session. */
  sceneKey: string;
  kind: 'group' | 'direct';
  label: string | null;
  lastActivityAt: number | null;
  ageDays: number | null;
  archived: boolean;
  /** The scene row still exists, so approval/mode survive the delete. */
  scenePresent: boolean;
  /** True when the age came from a store write instead of a real message. */
  storeWriteOnly: boolean;
  /** Newest session of the same scene under a different agent, if any. */
  sibling?: { agentId: string; ageDays: number | null };
  /** Task suffix of a derived session key (`...:task:<name>`), else null. */
  task: string | null;
};

export type SessionCleanupResult = { ok: true; text: string } | { ok: false; text: string };

function sceneLabel(
  registry: ReadonlyMap<string, BncrSceneRecord>,
  sceneKey: string,
  kind: 'group' | 'direct',
  platform: string,
  id: string,
): { label: string | null; scenePresent: boolean } {
  const rows = Array.from(registry.values()).filter(
    (row) => String(row.sceneKey ?? '').trim() === sceneKey,
  );
  if (rows.length === 0) return { label: null, scenePresent: false };
  // Every agent row carries the same scene, so the freshest one names it.
  const freshest = rows.reduce((best, row) =>
    Number(row.lastSeenAt ?? 0) > Number(best.lastSeenAt ?? 0) ? row : best,
  );
  const label = formatBncrSceneLabel({
    platform,
    id,
    name: kind === 'group' ? freshest.groupName : freshest.userName,
    customName: String(freshest.customName ?? '').trim(),
    maxNameChars: BNCR_SESSION_NAME_MAX_CHARS,
  });
  return { label, scenePresent: true };
}

function ageInDays(at: number | null, now: number): number | null {
  if (at == null || !Number.isFinite(at)) return null;
  return Math.floor(Math.max(0, now - at) / DAY_MS);
}

async function collectRows(
  deps: SessionCleanupDeps,
  days: number,
): Promise<{ rows: SessionCleanupRow[]; unreadable: string[]; total: number }> {
  const now = deps.now();
  const rows: SessionCleanupRow[] = [];
  const unreadable: string[] = [];
  let total = 0;
  for (const agentId of deps.agentIds) {
    const entries = await deps.listSessions(agentId).catch(() => undefined);
    // An unreadable store is unknown, never "every session is gone".
    if (!entries) {
      unreadable.push(agentId);
      continue;
    }
    for (const item of entries) {
      // Sessions of other channels share the same store; the key is the only
      // reliable boundary, so anything that does not parse as a bncr chat key
      // is left alone.
      // Derived task sessions carry a `:task:<name>` suffix; strip it so they
      // are listed and swept with their chat instead of lingering unseen.
      const taskMatch = item.sessionKey.match(/^(.*):task:([a-z0-9_-]{1,32})$/i);
      const baseKey = taskMatch ? taskMatch[1] : item.sessionKey;
      const parsed = parseStrictBncrSessionKey(baseKey);
      if (!parsed) continue;
      total += 1;
      const ageDays = ageInDays(item.lastActivityAt, now);
      const route = parsed.route;
      const kind = parsed.inputKind === 'group' ? 'group' : 'direct';
      const id = kind === 'group' ? String(route.groupId ?? '') : String(route.userId ?? '');
      const platform = String(route.platform ?? '');
      const sceneKey = `${platform}:${id}`;
      const scene = sceneLabel(deps.sceneRegistry, sceneKey, kind, platform, id);
      rows.push({
        agentId: String(agentId).trim(),
        sessionKey: item.sessionKey,
        sceneKey,
        kind,
        // A readable scene name beats whatever the host stored as a label.
        label: scene.label,
        lastActivityAt: item.lastActivityAt,
        ageDays,
        archived: item.archivedAt != null,
        scenePresent: scene.scenePresent,
        storeWriteOnly: item.hasInteractionAt === false,
        task: taskMatch ? taskMatch[2] : null,
      });
    }
  }
  // One chat can carry an old session per agent: the binding moves, the old
  // conversation stays. Mark the freshest sibling so a row never reads as
  // "this group went quiet" when another agent is still talking to it.
  const freshestByScene = new Map<string, { agentId: string; ageDays: number | null }>();
  for (const row of rows) {
    if (row.ageDays == null) continue;
    const current = freshestByScene.get(row.sceneKey);
    if (!current || (current.ageDays ?? Number.POSITIVE_INFINITY) > row.ageDays) {
      freshestByScene.set(row.sceneKey, { agentId: row.agentId, ageDays: row.ageDays });
    }
  }
  for (const row of rows) {
    const freshest = freshestByScene.get(row.sceneKey);
    if (freshest && freshest.agentId !== row.agentId) row.sibling = freshest;
  }
  const quiet = rows
    .filter((row) => row.ageDays != null && row.ageDays >= days)
    .sort((left, right) => (right.ageDays ?? 0) - (left.ageDays ?? 0));
  return { rows: quiet, unreadable, total };
}

function formatAge(value: number | null): string {
  return value == null ? 'unknown' : String(value) + 'd';
}

function describeRow(row: SessionCleanupRow): string {
  const parts = [
    (row.label ?? row.sceneKey) + (row.label ? '' : ' (no label)'),
    'agent=' + (row.agentId || '(unassigned)'),
    formatAge(row.ageDays),
    row.scenePresent ? 'scene=kept' : 'scene=missing (orphan)',
  ];
  if (row.archived) parts.push('archived');
  if (row.task) parts.push('task=' + row.task);
  // Two different ages hide behind one number: a real message and a store write.
  if (row.storeWriteOnly) parts.push('(store write, no message)');
  if (row.sibling) {
    parts.push(
      'other=' + row.sibling.agentId + ' ' + formatAge(row.sibling.ageDays) + ' (active chat)',
    );
  }
  return '  ' + parts.join('  ');
}

/** Bands keep a long list readable: 4x, 2x, and the threshold itself. */
function bandLabel(days: number, upper: number): string {
  const multiple = Math.round(upper / Math.max(days, 1));
  return multiple * days + 'd+';
}

function formatListText(
  rows: SessionCleanupRow[],
  days: number,
  total: number,
  unreadable: string[],
): string {
  const shown = rows.slice(0, BNCR_SESSION_CLEANUP_MAX_BATCH);
  const hidden = rows.length - shown.length;
  const lines: string[] = [
    '🧹 Bncr sessions — quiet ' +
      String(days) +
      'd+' +
      (days === BNCR_SESSION_CLEANUP_DEFAULT_DAYS ? ' (default)' : ''),
    '',
    String(total) +
      ' bncr session(s), ' +
      String(rows.length) +
      ' quiet ' +
      String(days) +
      'd+ (one row per agent; other= marks another agent still serving that chat)',
  ];
  if (unreadable.length > 0) {
    lines.push('Skipped: session store unreadable for ' + unreadable.join(', '));
  }
  if (shown.length === 0) {
    lines.push('', 'Nothing to clean up.');
    return lines.join('\n');
  }
  // Three bands, widest first, so the oldest leftovers are read first.
  const bands: Array<{ title: string; rows: SessionCleanupRow[] }> = [];
  const four = days * 4;
  const two = days * 2;
  const first = shown.filter((row) => (row.ageDays ?? 0) >= four);
  const second = shown.filter((row) => (row.ageDays ?? 0) >= two && (row.ageDays ?? 0) < four);
  const third = shown.filter((row) => (row.ageDays ?? 0) < two);
  if (first.length > 0) bands.push({ title: bandLabel(days, four), rows: first });
  if (second.length > 0) bands.push({ title: bandLabel(days, two), rows: second });
  if (third.length > 0) bands.push({ title: bandLabel(days, days), rows: third });
  for (const band of bands) {
    lines.push('', band.title + ' · ' + String(band.rows.length));
    for (const row of band.rows) lines.push(describeRow(row));
  }
  if (hidden > 0) {
    lines.push('', '… ' + String(hidden) + ' more; run it again after this batch.');
  }
  lines.push(
    '',
    'Delete: /bncr sessions prune' +
      (days === BNCR_SESSION_CLEANUP_DEFAULT_DAYS ? '' : ' ' + String(days)),
    'Scene rows and mode survive; only the conversation is dropped.',
  );
  return lines.join('\n');
}

async function pruneBatch(
  deps: SessionCleanupDeps,
  rows: SessionCleanupRow[],
  days: number,
): Promise<{ deleted: SessionCleanupRow[]; revived: string[]; alreadyGone: number }> {
  const deleted: SessionCleanupRow[] = [];
  const revived: string[] = [];
  let alreadyGone = 0;
  const now = deps.now();
  for (const row of rows.slice(0, BNCR_SESSION_CLEANUP_MAX_BATCH)) {
    // Re-read right before deleting: a message that landed since the listing
    // must keep its conversation.
    if (deps.readSession) {
      let current: BncrSessionActivity | undefined;
      try {
        current = await deps.readSession({
          agentId: row.agentId,
          sessionKey: row.sessionKey,
        });
      } catch {
        revived.push(row.sceneKey + ' (unreadable)');
        continue;
      }
      if (!current) {
        alreadyGone += 1;
        continue;
      }
      const currentAge = ageInDays(current.lastActivityAt, now);
      if (currentAge == null || currentAge < days) {
        revived.push(row.sceneKey + '/' + row.agentId);
        continue;
      }
    }
    try {
      // Archive the transcript: the conversation stays recoverable on disk while
      // the sidebar entry disappears.
      await deps.deleteSession({
        agentId: row.agentId,
        sessionKey: row.sessionKey,
        archiveTranscript: true,
      });
      deleted.push(row);
    } catch {
      // A failed delete must not abort the batch; the row is reported instead.
      revived.push(row.sceneKey + ' (delete failed)');
    }
  }
  return { deleted, revived, alreadyGone };
}

/**
 * Execute /bncr sessions.
 *
 * Operator driven only: nothing on the inbound path calls this, so a sweep can
 * never race a live message into losing its conversation.
 */
export async function executeSessionCleanupCommand(
  args: { command: SessionCleanupCommand } & SessionCleanupDeps,
): Promise<SessionCleanupResult> {
  const { command, ...deps } = args;
  if (command.action === 'help') return { ok: true, text: SESSION_CLEANUP_HELP_TEXT };

  const { rows, unreadable, total } = await collectRows(deps, command.days);
  if (command.action === 'list') {
    if (
      rows.length === 0 &&
      unreadable.length === deps.agentIds.length &&
      deps.agentIds.length > 0
    ) {
      return { ok: false, text: '🧹 Cannot list sessions: the session store is unreadable.' };
    }
    return { ok: true, text: formatListText(rows, command.days, total, unreadable) };
  }

  if (rows.length === 0) {
    return {
      ok: true,
      text:
        '🧹 Nothing to delete: no bncr session is quiet ' +
        String(command.days) +
        'd+' +
        (unreadable.length > 0 ? ' (' + unreadable.join(', ') + ' unreadable)' : '') +
        '.',
    };
  }

  const { deleted, revived, alreadyGone } = await pruneBatch(deps, rows, command.days);
  const lines: string[] = ['🧹 Session cleanup'];
  lines.push(
    'Deleted ' +
      String(deleted.length) +
      ' session(s)' +
      (alreadyGone > 0 ? ' · ' + String(alreadyGone) + ' already gone' : '') +
      (revived.length > 0 ? ' · ' + String(revived.length) + ' skipped' : ''),
  );
  if (deleted.length > 0) {
    for (const row of deleted) lines.push(describeRow(row));
    lines.push('', 'Scene rows kept: approval, mode, name and group are unchanged.');
  }
  if (revived.length > 0) {
    lines.push('', 'Skipped (active again or unreadable): ' + revived.join(', '));
  }
  const remaining = rows.length - deleted.length - alreadyGone - revived.length;
  if (remaining > 0) {
    lines.push('', '… ' + String(remaining) + ' more in this batch; run it again.');
  }
  return { ok: true, text: lines.join('\n') };
}
