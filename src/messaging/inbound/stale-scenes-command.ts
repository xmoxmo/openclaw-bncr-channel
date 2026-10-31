import { buildCanonicalBncrSessionKey } from '../../core/targets.ts';
import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';
import { buildAgentSceneRegistryKey, deleteSceneRecord } from '../../plugin/scene-registry.ts';
import { STALE_SCENES_FILTERS } from './command-constants.ts';
import type { NativeCommand } from './native-command.ts';
import { unknownAgentText } from './scene-admin.ts';
import {
  BNCR_SESSION_NAME_MAX_CHARS,
  formatBncrSceneLabel,
  parseBncrSceneTargets,
} from './session-identity.ts';

/** A scene row and its host session both have to be quiet this long to count as dead. */
export const BNCR_STALE_SCENE_MS = 72 * 60 * 60 * 1000;

/** A sibling scene on another platform this fresh means the chat moved there. */
export const BNCR_SIBLING_ACTIVE_MS = 24 * 60 * 60 * 1000;

/** Re-exported so callers can keep importing the filter list with the command. */
export { STALE_SCENES_FILTERS };

const STALE_FILTER_LIST = STALE_SCENES_FILTERS.join('|');

/** Internal config rows (the global media default) are not chats and never stale. */
const INTERNAL_SCENE_PREFIX = '__';

const STALE_USAGE_TEXT = [
  'Usage:',
  '  /bncr stale [' + STALE_FILTER_LIST + ']',
  '  /bncr stale help',
  '  /bncr prune <SceneId> [<agentId>] [force]',
].join('\n');

export const STALE_SCENES_HELP_TEXT = [
  '🧹 Stale scenes',
  '',
  'Lists scene rows that are cleanup candidates: row and host session both quiet 72h+,',
  'or the host session was deleted or archived from the UI (read-only session listing,',
  'archived entries included). Nothing is pruned automatically.',
  '',
  'Commands:',
  '  • /bncr stale [' + STALE_FILTER_LIST + ']',
  '    List cleanup candidates by SceneId with the sidebar label and sibling activity.',
  '    all = every candidate (default); swapped = another platform on the same group was',
  '    active within 24h; solo = no sibling active and no session anomaly, the chat is',
  '    just quiet;',
  '    missing = host session gone (UI-deleted or never created);',
  '    archived = host session archived from the UI',
  '  • /bncr prune <SceneId> [<agentId>] [force]',
  '    Archive the host transcript, wipe the session state (routes, history, shards,',
  '    outbox), then delete the scene row; force skips both guards (72h activity',
  '    and an unreadable session)',
  '',
  'Targets follow the usual tail: without <agentId> every agent on that SceneId is pruned.',
  'If the session listing cannot be read, rows fall back to the 72h clock and are',
  'marked unreadable (unknown); they are never called missing/archived, and are',
  'skipped only when the clock read fails too.',
  'SceneId and agentId may be written in either order. A trailing "force" is reserved for',
  'the override, so an agent literally named force needs it written twice. Internal config',
  'rows (the global media default) are never listed and cannot be pruned.',
  'Admin only.',
].join('\n');

export type StaleScenesFilter = (typeof STALE_SCENES_FILTERS)[number];

/**
 * 派生层：一行的判定只在这里做一次，下游只读派生结果。
 *
 * 原始时间戳的含义并不相同：`lastSeenAt` 是聊天本身的活动，会话库的
 * `updatedAt` 只是「最后一次写库」，归档、改标签这类管理动作同样会写库。
 * 谁要是直接拿 `sessionAt` 当活跃时间，就会把死场景算成刚活跃。
 * 所以 `sessionAnomaly` / `archivedAt` / `lastActivityAt` 在这里算好，
 * stale 判定、sibling 活动、solo/swapped 过滤和展示文案都只读这三个字段。
 */
function classifySessionAnomaly(
  status: StaleSceneRow['sessionStatus'],
): 'missing' | 'archived' | null {
  if (status === 'missing') return 'missing';
  if (status === 'archived') return 'archived';
  return null;
}

export type StaleScenesCommand =
  | { action: 'list'; filter: StaleScenesFilter }
  | { action: 'help' }
  | { action: 'prune'; sceneKey: string; agentId?: string; force: boolean };

export type ParsedStaleScenesCommand =
  | { matched: false }
  | { matched: true; valid: false; text: string }
  | { matched: true; valid: true; command: StaleScenesCommand };

function splitArgs(raw: string): string[] {
  return String(raw ?? '')
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeToken(value: unknown): string {
  return String(value ?? '').trim();
}

function isInternalSceneKey(sceneKey: unknown): boolean {
  return normalizeToken(sceneKey).startsWith(INTERNAL_SCENE_PREFIX);
}

export function parseStaleScenesCommand(command: NativeCommand): ParsedStaleScenesCommand {
  const name = normalizeToken(command.command).toLowerCase();
  if (name !== 'stale' && name !== 'prune') return { matched: false };

  const args = splitArgs(command.argsText);
  if (args.length === 1 && args[0].toLowerCase() === 'help') {
    return { matched: true, valid: true, command: { action: 'help' } };
  }

  if (name === 'stale') {
    if (args.length === 0) {
      return { matched: true, valid: true, command: { action: 'list', filter: 'all' } };
    }
    const filter = args[0].toLowerCase();
    if (args.length === 1 && (STALE_SCENES_FILTERS as readonly string[]).includes(filter)) {
      return {
        matched: true,
        valid: true,
        command: { action: 'list', filter: filter as StaleScenesFilter },
      };
    }
    return { matched: true, valid: false, text: STALE_USAGE_TEXT };
  }

  const force = args.length > 0 && args[args.length - 1].toLowerCase() === 'force';
  const targets = parseBncrSceneTargets(force ? args.slice(0, -1) : args);
  // Pruning always needs an explicit SceneId: the current chat is exactly the
  // row an operator is most likely to delete by accident.
  if (!targets?.sceneKey) return { matched: true, valid: false, text: STALE_USAGE_TEXT };
  return {
    matched: true,
    valid: true,
    command: {
      action: 'prune',
      sceneKey: targets.sceneKey,
      ...(targets.agentId ? { agentId: targets.agentId } : {}),
      force,
    },
  };
}

export type StaleScenesDeps = {
  sceneRegistry: Map<string, BncrSceneRecord>;
  now: () => number;
  staleMs?: number;
  siblingActiveMs?: number;
  readSessionUpdatedAt: (args: {
    agentId: string;
    sessionKey: string;
  }) => Promise<number | null | undefined>;
  /** Reverse-lookup the host session node (existence + archived_at). When
   * present it supersedes readSessionUpdatedAt for existence/timestamp, so the
   * list can flag sessions the operator deleted or archived from the UI. */
  readSessionNode?: (args: {
    agentId: string;
    sessionKey: string;
  }) => Promise<
    { exists: boolean; archivedAt: number | null; updatedAt: number | null } | undefined
  >;
  deleteSession: (args: {
    agentId: string;
    sessionKey: string;
    archiveTranscript?: boolean;
  }) => Promise<boolean>;
  /** Wipe every stored artifact for the session behind this scene row. */
  purgeSessionState?: (args: {
    sceneKey: string;
    agentId: string;
    sessionKey: string | null;
  }) => Promise<void> | void;
};

export type StaleSceneRow = {
  scene: BncrSceneRecord;
  agentId: string;
  sessionKey: string | null;
  rowAt: number;
  sessionAt: number | null;
  /** The host session read failed; treat activity as unknown, never as dead. */
  sessionUnknown: boolean;
  stale: boolean;
  /** Host session node status: deleted (missing), archived, alive, or unreadable. */
  sessionStatus: 'alive' | 'missing' | 'archived' | 'unknown';
  /** Derived: the session state that makes this row a candidate on its own. */
  sessionAnomaly: 'missing' | 'archived' | null;
  /** Derived: when the host archived the session, not when it was last used. */
  archivedAt: number | null;
  /** Derived: the last time the chat itself was used (never a store-only write). */
  lastActivityAt: number;
  /** Newest activity of a same-group scene on a different platform. */
  sibling?: { sceneKey: string; platform: string; at: number };
  siblingActive: boolean;
};

function sceneIdentityId(scene: BncrSceneRecord): string {
  return scene.kind === 'group' ? normalizeToken(scene.groupId) : normalizeToken(scene.userId);
}

export function buildStaleSceneSessionKey(scene: BncrSceneRecord, agentId: string): string | null {
  const platform = normalizeToken(scene.platform);
  const id = sceneIdentityId(scene);
  if (!platform || !id || !agentId) return null;
  return buildCanonicalBncrSessionKey(
    scene.kind === 'group'
      ? { platform, groupId: id, userId: '0' }
      : { platform, groupId: '0', userId: id },
    agentId,
  );
}

export function formatStaleSceneLabel(scene: BncrSceneRecord, maxNameChars?: number): string {
  return (
    formatBncrSceneLabel({
      platform: scene.platform,
      id: sceneIdentityId(scene),
      name: scene.kind === 'group' ? scene.groupName : scene.userName,
      customName: normalizeToken(scene.customName),
      maxNameChars: maxNameChars ?? BNCR_SESSION_NAME_MAX_CHARS,
    }) || scene.sceneKey
  );
}

function formatClock(ms: number | null): string {
  if (ms == null || !Number.isFinite(Number(ms))) return 'none';
  const date = new Date(Number(ms));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatAge(ms: number | null, now: number): string {
  if (ms == null || !Number.isFinite(Number(ms))) return 'none';
  const hours = (now - Number(ms)) / 3_600_000;
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

async function inspectSceneRow(
  scene: BncrSceneRecord,
  deps: StaleScenesDeps,
  now: number,
  staleMs: number,
): Promise<StaleSceneRow> {
  const agentId = normalizeToken(scene.agentId);
  const sessionKey = buildStaleSceneSessionKey(scene, agentId);
  const rowAt = Number(scene.lastSeenAt) || 0;
  let sessionAt: number | null = null;
  let archivedAt: number | null = null;
  let sessionUnknown = false;
  let sessionStatus: StaleSceneRow['sessionStatus'] = 'unknown';
  if (sessionKey) {
    let node: Awaited<ReturnType<NonNullable<StaleScenesDeps['readSessionNode']>>>;
    if (deps.readSessionNode) {
      // Preferred path: reverse-look-up the persistence table so a session the
      // operator deleted or archived from the UI is surfaced as an anomaly even
      // when the scene row itself is fresh.
      try {
        node = await deps.readSessionNode({ agentId, sessionKey });
      } catch {
        node = undefined;
      }
      if (node) {
        if (!node.exists) {
          sessionStatus = 'missing';
        } else {
          sessionAt =
            typeof node.updatedAt === 'number' && Number.isFinite(node.updatedAt)
              ? node.updatedAt
              : null;
          sessionStatus = node.archivedAt != null ? 'archived' : 'alive';
          archivedAt =
            typeof node.archivedAt === 'number' && Number.isFinite(node.archivedAt)
              ? node.archivedAt
              : null;
        }
      }
    }
    if (!node) {
      // Session listing unavailable. Keep the status unknown so missing/archived
      // never fire on a guess, but let the timestamp reader carry the quiet rule:
      // a store hiccup must not wipe the whole stale list the way it did before.
      try {
        const value = await deps.readSessionUpdatedAt({ agentId, sessionKey });
        // `undefined` means the read itself failed; `null` means the store answered
        // and there is no entry. The two must not be conflated.
        if (value === undefined) sessionUnknown = true;
        else sessionAt = typeof value === 'number' && Number.isFinite(value) ? value : null;
      } catch {
        sessionUnknown = true;
      }
    }
  }
  // A missing timestamp is unknown, not fresh: a row with no recorded inbound
  // time has nothing that could keep it alive.
  const rowQuiet = rowAt <= 0 || now - rowAt > staleMs;
  // A missing session counts as quiet: nothing is left to keep the scene warm.
  const sessionQuiet = sessionAt == null || now - sessionAt > staleMs;
  const sessionAnomaly = classifySessionAnomaly(sessionStatus);
  // Only a session we could actually read as alive contributes activity. A
  // deleted session has no timestamp, an archived one only carries the moment
  // it was archived, and an unreadable listing tells us nothing about whether
  // the chat is still in use — none of them may be reported as "the chat moved
  // there".
  const lastActivityAt = sessionStatus === 'alive' ? Math.max(rowAt, sessionAt ?? 0) : rowAt;
  return {
    scene,
    agentId,
    sessionKey,
    rowAt,
    sessionAt,
    sessionUnknown,
    sessionStatus,
    sessionAnomaly,
    archivedAt,
    lastActivityAt,
    // A deleted/archived host session is a cleanup candidate regardless of the
    // row clock; otherwise fall back to the 72h quiet rule. An unreadable store
    // is never proof of death, so it is never stale.
    stale: !sessionUnknown && (sessionAnomaly !== null || (rowQuiet && sessionQuiet)),
    siblingActive: false,
  };
}

async function inspectAll(deps: StaleScenesDeps): Promise<{ rows: StaleSceneRow[]; now: number }> {
  const now = deps.now();
  const staleMs = deps.staleMs ?? BNCR_STALE_SCENE_MS;
  const scenes = Array.from(deps.sceneRegistry.values()).filter(
    (scene) => !isInternalSceneKey(scene.sceneKey),
  );
  const rows = await Promise.all(scenes.map((scene) => inspectSceneRow(scene, deps, now, staleMs)));
  attachSiblings(rows, now, deps.siblingActiveMs ?? BNCR_SIBLING_ACTIVE_MS);
  return { rows, now };
}

/**
 * Mark each group row with the newest activity of the same group on another
 * platform. A group id is only reused across platforms when it is really the
 * same chat, and a sibling that moved within a day is the signal that this row
 * is a leftover entry from the platform the chat left.
 */
function attachSiblings(rows: StaleSceneRow[], now: number, activeMs: number): void {
  const byGroup = new Map<string, StaleSceneRow[]>();
  for (const row of rows) {
    if (row.scene.kind !== 'group') continue;
    const id = sceneIdentityId(row.scene);
    if (!id) continue;
    const bucket = byGroup.get(id);
    if (bucket) bucket.push(row);
    else byGroup.set(id, [row]);
  }
  for (const row of rows) {
    if (row.scene.kind !== 'group') continue;
    const platform = normalizeToken(row.scene.platform);
    const siblings = (byGroup.get(sceneIdentityId(row.scene)) ?? []).filter(
      (other) => other !== row && normalizeToken(other.scene.platform) !== platform,
    );
    let best: StaleSceneRow | undefined;
    let bestAt = 0;
    for (const sibling of siblings) {
      const at = sibling.lastActivityAt;
      if (at > bestAt) {
        bestAt = at;
        best = sibling;
      }
    }
    if (!best || bestAt <= 0) continue;
    row.sibling = {
      sceneKey: normalizeToken(best.scene.sceneKey),
      platform: normalizeToken(best.scene.platform),
      at: bestAt,
    };
    row.siblingActive = now - bestAt <= activeMs;
  }
}

function groupStaleRows(rows: StaleSceneRow[]): Array<[string, StaleSceneRow[]]> {
  const grouped = new Map<string, StaleSceneRow[]>();
  for (const row of rows) {
    const key = normalizeToken(row.scene.sceneKey);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  // Oldest silence first: those are the rows an operator most likely wants gone.
  return Array.from(grouped.entries()).sort(([, left], [, right]) => {
    const oldest = (bucket: StaleSceneRow[]) => Math.min(...bucket.map((row) => row.rowAt));
    return oldest(left) - oldest(right);
  });
}

function describeRow(row: StaleSceneRow, now: number): string {
  const agent = row.agentId || '(unassigned)';
  let sessionText: string;
  if (row.sessionUnknown) {
    sessionText = 'unreadable (unknown)';
  } else if (row.sessionStatus === 'missing') {
    sessionText = 'missing (no session row)';
  } else if (row.sessionStatus === 'archived') {
    // Show when it was archived, not when the store was last written: the two
    // differ exactly when someone archived the session long after using it.
    const archivedAt = row.archivedAt ?? row.sessionAt;
    sessionText = 'archived ' + formatClock(archivedAt) + ' (' + formatAge(archivedAt, now) + ')';
  } else {
    sessionText = formatClock(row.sessionAt) + ' (' + formatAge(row.sessionAt, now) + ')';
  }
  const sibling = row.sibling
    ? row.sibling.platform +
      ' ' +
      formatAge(row.sibling.at, now) +
      (row.siblingActive ? ' (active)' : '')
    : 'none';
  return (
    '  ' +
    agent +
    '  row=' +
    formatClock(row.rowAt) +
    ' (' +
    formatAge(row.rowAt, now) +
    ')  session=' +
    sessionText +
    '  sibling=' +
    sibling
  );
}

const FILTER_CAPTION: Record<StaleScenesFilter, string> = {
  all: '',
  swapped: ' · swapped: another platform on the same group active within 24h',
  solo: ' · solo: no sibling platform active within 24h and no session anomaly',
  missing: ' · missing: host session gone (UI-deleted or never created)',
  archived: ' · archived: host session archived from the UI',
};

/** A chat message cannot carry an unbounded list; older rows drop off first. */
const MAX_LISTED_ROWS = 50;

function formatStaleList(
  rows: StaleSceneRow[],
  now: number,
  total: number,
  filter: StaleScenesFilter,
  unknown: number,
): string {
  const headerBase =
    filter === 'missing' || filter === 'archived'
      ? '🧹 Stale scenes'
      : '🧹 Stale scenes — quiet 72h+ or session missing/archived';
  const lines: string[] = [
    headerBase + FILTER_CAPTION[filter],
    `${rows.length} of ${total} scene rows`,
  ];
  if (unknown > 0) lines.push(`${unknown} row(s) skipped: session unreadable`);
  let printed = 0;
  let hidden = 0;
  for (const [sceneKey, bucket] of groupStaleRows(rows)) {
    if (printed >= MAX_LISTED_ROWS) {
      hidden += bucket.length;
      continue;
    }
    const shown = bucket.slice(0, MAX_LISTED_ROWS - printed);
    hidden += bucket.length - shown.length;
    lines.push('', sceneKey);
    const labels = new Set(bucket.map((row) => formatStaleSceneLabel(row.scene)));
    if (labels.size === 1) {
      const label = formatStaleSceneLabel(bucket[0].scene);
      if (label && label !== sceneKey) lines.push('  ' + label);
      for (const row of shown) lines.push(describeRow(row, now));
    } else {
      // Agents in one scene can carry different custom names; show each row's
      // own label instead of pretending they share one.
      for (const row of shown) {
        lines.push(describeRow(row, now));
        lines.push('    label: ' + formatStaleSceneLabel(row.scene));
      }
    }
    printed += shown.length;
  }
  if (hidden > 0) {
    lines.push(
      '',
      `… ${hidden} more row(s); narrow with /bncr stale swapped|solo|missing|archived.`,
    );
  }
  lines.push('', 'Prune one: /bncr prune <SceneId> [<agentId>]');
  return lines.join('\n');
}

function formatPruned(pruned: StaleSceneRow[], now: number, skipped: string[]): string {
  const lines: string[] = [];
  if (pruned.length === 0) {
    lines.push('🧹 Nothing pruned: every target row moved after the listing.');
  } else {
    lines.push('🧹 Pruned ' + pruned.length + ' scene row(s)');
    for (const row of pruned) {
      lines.push(
        '',
        normalizeToken(row.scene.sceneKey),
        '  ' + formatStaleSceneLabel(row.scene),
        describeRow(row, now).trim(),
      );
    }
  }
  if (skipped.length > 0) lines.push('', 'Skipped (active again): ' + skipped.join(', '));
  return lines.join('\n');
}

export type StaleScenesResult = { ok: true; text: string } | { ok: false; text: string };

/**
 * Execute /bncr stale or /bncr prune.
 *
 * Both are operator driven: nothing here runs on the inbound path, so a cleanup
 * can never race a live message and delete a scene that just woke up.
 */
export async function executeStaleScenesCommand(
  args: { command: StaleScenesCommand } & StaleScenesDeps,
): Promise<StaleScenesResult> {
  const { command, ...deps } = args;
  if (command.action === 'help') return { ok: true, text: STALE_SCENES_HELP_TEXT };

  if (command.action === 'list') {
    const { rows, now } = await inspectAll(deps);
    // Nothing has ever come in on this bridge: saying "every row moved within
    // 72h" would describe rows that do not exist.
    if (rows.length === 0) {
      return { ok: true, text: '🧹 No scene rows yet: nothing to clean up.' };
    }
    const stale = rows.filter((row) => row.stale);
    const filtered = stale.filter((row) => {
      if (command.filter === 'swapped') return row.siblingActive;
      // "solo" means the chat simply went quiet: a deleted or archived session
      // has its own filter, and listing it here would hide that the row is an
      // anomaly rather than a quiet chat.
      if (command.filter === 'solo') return !row.siblingActive && row.sessionAnomaly === null;
      if (command.filter === 'missing') return row.sessionAnomaly === 'missing';
      if (command.filter === 'archived') return row.sessionAnomaly === 'archived';
      return true;
    });
    const unknown = rows.filter((row) => row.sessionUnknown).length;
    const unknownNote = unknown > 0 ? ' ' + unknown + ' row(s) skipped: session unreadable.' : '';
    if (filtered.length === 0) {
      if (stale.length > 0) {
        return {
          ok: true,
          text:
            '🧹 No stale scene matched ' +
            command.filter +
            ': ' +
            stale.length +
            ' stale row(s) exist.' +
            unknownNote,
        };
      }
      return {
        ok: true,
        text: '🧹 No stale scenes: every row or its session moved within 72h.' + unknownNote,
      };
    }
    return { ok: true, text: formatStaleList(filtered, now, rows.length, command.filter, unknown) };
  }

  const sceneKey = normalizeToken(command.sceneKey);
  const wantedAgent = normalizeToken(command.agentId);
  if (isInternalSceneKey(sceneKey)) {
    return { ok: false, text: 'Not a chat scene: ' + sceneKey + ' is an internal config row.' };
  }
  const matching = Array.from(deps.sceneRegistry.values()).filter(
    (scene) => normalizeToken(scene.sceneKey) === sceneKey,
  );
  if (matching.length === 0) return { ok: false, text: 'Scene not found: ' + sceneKey };

  const targets = matching.filter(
    (scene) => !wantedAgent || normalizeToken(scene.agentId) === wantedAgent,
  );
  // Same message as every other scene command: one wording, one place.
  if (targets.length === 0)
    return { ok: false, text: unknownAgentText(wantedAgent, sceneKey, matching) };

  const now = deps.now();
  const staleMs = deps.staleMs ?? BNCR_STALE_SCENE_MS;
  const inspected = await Promise.all(
    targets.map((scene) => inspectSceneRow(scene, deps, now, staleMs)),
  );

  // Fail closed: a row whose session store could not be read is not evidence of
  // death, so it blocks the prune the same way a live row does.
  const unverified = inspected.filter((row) => row.sessionUnknown);
  if (unverified.length > 0 && !command.force) {
    return {
      ok: false,
      text: [
        'Refusing to prune ' + sceneKey + ': session activity could not be read',
        ...unverified.map((row) => describeRow(row, now)),
        '',
        'Retry once the session store is readable, or force to delete anyway: /bncr prune ' +
          sceneKey +
          (wantedAgent ? ' ' + wantedAgent : '') +
          ' force',
      ].join('\n'),
    };
  }

  const active = inspected.filter((row) => !row.stale);
  if (active.length > 0 && !command.force) {
    return {
      ok: false,
      text: [
        'Refusing to prune ' + sceneKey + ': still active within 72h',
        ...active.map((row) => describeRow(row, now)),
        '',
        'Re-run with force to delete anyway: /bncr prune ' +
          sceneKey +
          (wantedAgent ? ' ' + wantedAgent : '') +
          ' force',
      ].join('\n'),
    };
  }

  const pruned: StaleSceneRow[] = [];
  const skipped: string[] = [];
  for (const row of inspected) {
    // A message can land between the listing and this loop. The registry holds
    // the live row, so a changed lastSeenAt means the scene woke up: leave both
    // the row and its session alone instead of deleting a chat that is in use.
    const current = deps.sceneRegistry.get(
      buildAgentSceneRegistryKey(row.scene.sceneKey, row.agentId),
    );
    if (!current || Number(current.lastSeenAt) !== row.rowAt) {
      skipped.push(normalizeToken(row.scene.sceneKey) + '/' + (row.agentId || '(unassigned)'));
      continue;
    }
    if (row.sessionKey) {
      try {
        await deps.deleteSession({
          agentId: row.agentId,
          sessionKey: row.sessionKey,
          archiveTranscript: true,
        });
      } catch {
        // A missing store or an already-deleted session must not stop the row
        // removal: the row is the part that keeps the dead scene listed.
      }
    }
    try {
      await deps.purgeSessionState?.({
        sceneKey: normalizeToken(row.scene.sceneKey),
        agentId: row.agentId,
        sessionKey: row.sessionKey,
      });
    } catch {
      // Purging stored artifacts is best-effort; the scene row removal is the
      // operator-visible outcome and must still proceed.
    }
    deleteSceneRecord(deps.sceneRegistry, row.scene.sceneKey, row.agentId);
    pruned.push(row);
  }

  return { ok: true, text: formatPruned(pruned, now, skipped) };
}
