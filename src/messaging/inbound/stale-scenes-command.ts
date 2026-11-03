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

/** Batch cleanup default: a scene nobody touched for half a year is a leftover. */
export const BNCR_STALE_SCENE_BATCH_DAYS = 180;

/** One sweep deletes at most this many rows; run it again for the rest. */
export const BNCR_STALE_SCENE_BATCH_MAX = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sibling scene on another platform this fresh means the chat moved there. */
export const BNCR_SIBLING_ACTIVE_MS = 24 * 60 * 60 * 1000;

/** Re-exported so callers can keep importing the filter list with the command. */
export { STALE_SCENES_FILTERS };

const STALE_FILTER_LIST = STALE_SCENES_FILTERS.join('|');

/** Internal config rows (the global media default) are not chats and never stale. */
const INTERNAL_SCENE_PREFIX = '__';

const STALE_USAGE_TEXT = [
  'Usage:',
  '  /bncr stale help',
  '  /bncr stale',
  `  /bncr stale [${STALE_FILTER_LIST}]`,
  '  /bncr stale <days>',
  '  /bncr stale orphans',
  '  /bncr prune <SceneId> [<agentId>] [force]',
  '  /bncr prune stale [<days>] [force]',
  '  /bncr prune state <SceneId> [force]',
].join('\n');

export const STALE_SCENES_HELP_TEXT = [
  '🧹 Stale scenes',
  '',
  'About:',
  '  • 列出可以清理的场景记录：场景行和宿主会话都超过窗口没动静，或在诊断视图里被删除/归档。',
  '  • 查询只读，不会自动清理；清理要显式发 /bncr prune。',
  '  • 会话列表读不出来时按时钟判断并标成 unreadable（unknown），不会误判成 missing/archived，',
  '    只有时钟也读不出来才跳过。',
  '  • 内部配置行（下载媒体的全局默认）不会列出，也不能清理。',
  '  • 仅管理员可用。',
  '',
  'Commands:',
  '  • /bncr stale',
  '    清理视图，只看时钟：超过 ' +
    String(BNCR_STALE_SCENE_BATCH_DAYS) +
    ' 天没动静的行；单纯会话异常不会把行拉进来。',
  `  • /bncr stale [${STALE_FILTER_LIST}]`,
  '    诊断视图，按 72 小时判定，包含会话异常；按场景列出，带侧边栏标签和同群其它平台的活动。',
  '    all = 全部候选；swapped = 同群另一个平台 24 小时内有过活动；',
  '    solo = 同群没活动、也没会话异常，只是没人说话；',
  '    missing = 宿主会话没了（网页删掉或从没创建）；archived = 宿主会话被归档',
  '  • /bncr stale <days>',
  '    同清理视图，天数自己定。',
  '  • /bncr stale orphans',
  '    反向核对客户端：列出插件仍在门控（oc/occ、mode）但场景表里没有行的场景。',
  '    门控在第一条消息之前就打开、或场景行在客户端背后被删掉，都长这样。只读。',
  '  • /bncr prune <SceneId> [<agentId>] [force]',
  '    归档宿主会话记录，清掉会话状态（路由、历史、分片、发件箱），再删场景行；',
  '    force 跳过两道守卫（72 小时活动和会话不可读）。',
  '  • /bncr prune stale [<days>] [force]',
  '    批量清理超过 <days>（缺省 ' +
    String(BNCR_STALE_SCENE_BATCH_DAYS) +
    ' 天）的行，最老的先来，每次最多 ' +
    String(BNCR_STALE_SCENE_BATCH_MAX) +
    ' 行。',
  '    每行走和单条清理一样的步骤，最后统一请客户端丢掉对应状态。',
  '  • /bncr prune state <SceneId> [force]',
  '    只清客户端门控，不动场景表；用于 /bncr stale orphans 列出来的孤儿。',
  '    门控在 72 小时内开过要加 force，因为那也可能是还没来消息的超级门控。',
  '',
  'Format:',
  '  • <agentId> — 省略就清理该场景下的所有 agent',
  '  • <SceneId> — 平台:群id 或 平台:用户id',
  '  • <agentId> 和 <SceneId> 顺序随意；末尾的 force 是保留字，agent 恰好叫 force 要写两次',
].join('\n');

export type StaleScenesFilter = (typeof STALE_SCENES_FILTERS)[number];

/** One row of the client's own scene gate table (bncr.state.list, normalised). */
export type BncrClientSceneStateEntry = {
  sceneKey: string;
  scope?: string;
  enabled?: boolean;
  mode?: string;
  rev?: number;
};

/** Client gate table read result. `unsupported` = client too old for the RPC. */
export type BncrClientSceneStateList = {
  ok?: boolean;
  entries?: BncrClientSceneStateEntry[];
  invalid?: number;
  unsupported?: boolean;
  error?: string;
};

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
  | {
      action: 'list';
      filter: StaleScenesFilter;
      days?: number;
      /**
       * Session anomalies (missing/archived) count as candidates regardless of
       * the clock. Omitted keeps the diagnostic behaviour (anomalies included);
       * the parser always states it, so the cleanup views pass false explicitly.
       */
      includeAnomalies?: boolean;
    }
  | { action: 'help' }
  | { action: 'prune'; sceneKey: string; agentId?: string; force: boolean }
  | { action: 'prune-state'; sceneKey: string; force: boolean }
  | { action: 'prune-batch'; days: number; force: boolean }
  | { action: 'orphans' };

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

/** Day counts stay in a range an operator can reason about; empty keeps the default. */
function parseBatchDays(raw: string | undefined): number | null {
  const text = normalizeToken(raw);
  if (!text) return BNCR_STALE_SCENE_BATCH_DAYS;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 1 || value > 3650) return null;
  return Math.floor(value);
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
    // No argument is the cleanup view: a half year of silence, clock only.
    // `all` keeps the old 72h diagnostic view, anomalies included.
    if (args.length === 0) {
      return {
        matched: true,
        valid: true,
        command: {
          action: 'list',
          filter: 'all',
          days: BNCR_STALE_SCENE_BATCH_DAYS,
          includeAnomalies: false,
        },
      };
    }
    const filter = args[0].toLowerCase();
    // /bncr stale orphans reads the client's own gate state instead of the
    // scene table, so it is its own view rather than another row filter.
    if (args.length === 1 && filter === 'orphans') {
      return { matched: true, valid: true, command: { action: 'orphans' } };
    }
    if (args.length === 1 && (STALE_SCENES_FILTERS as readonly string[]).includes(filter)) {
      return {
        matched: true,
        valid: true,
        command: {
          action: 'list',
          filter: filter as StaleScenesFilter,
          includeAnomalies: true,
        },
      };
    }
    // /bncr stale <days>: the same listing with a day threshold instead of 72h.
    if (args.length === 1 && /^\d+$/.test(filter)) {
      const days = parseBatchDays(filter);
      if (days == null) return { matched: true, valid: false, text: STALE_USAGE_TEXT };
      return {
        matched: true,
        valid: true,
        command: { action: 'list', filter: 'all', days, includeAnomalies: false },
      };
    }
    return { matched: true, valid: false, text: STALE_USAGE_TEXT };
  }

  const force = args.length > 0 && args[args.length - 1].toLowerCase() === 'force';
  const rest = force ? args.slice(0, -1) : args;
  // /bncr prune stale [<days>] [force]: batch mode never parses a SceneId, so an
  // operator cannot accidentally aim it at one chat.
  if (rest.length > 0 && rest[0].toLowerCase() === 'stale') {
    if (rest.length > 2) return { matched: true, valid: false, text: STALE_USAGE_TEXT };
    const days = parseBatchDays(rest[1]);
    if (days == null) return { matched: true, valid: false, text: STALE_USAGE_TEXT };
    return { matched: true, valid: true, command: { action: 'prune-batch', days, force } };
  }
  // /bncr prune state <SceneId> [force]: 孤儿门控——场景表没有这一行，
  // 能清的只有客户端自己那份 state。
  if (rest.length > 0 && rest[0].toLowerCase() === 'state') {
    const stateTargets = parseBncrSceneTargets(rest.slice(1));
    // The client gate is scene level, not agent level: an agent id here would
    // silently clear the sibling agent's gate too.
    if (!stateTargets?.sceneKey || stateTargets.agentId)
      return { matched: true, valid: false, text: STALE_USAGE_TEXT };
    return {
      matched: true,
      valid: true,
      command: { action: 'prune-state', sceneKey: stateTargets.sceneKey, force },
    };
  }
  const targets = parseBncrSceneTargets(rest);
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
  /**
   * Persist the scene registry after rows were removed. Deleting a row only
   * touches the in-memory map and the purge step may throw, so the sweep asks
   * for one save itself instead of relying on a neighbour's side effect.
   */
  onSceneChange?: () => void;
  /**
   * Ask the Bncr client to drop its own per-scene state (mode/occ) for the
   * pruned scenes. Batch mode cannot be parsed from command text the way a
   * single /bncr prune is, so the host hands the keys over directly.
   */
  clearClientState?: (
    sceneKeys: string[],
  ) => Promise<
    { ok?: boolean; cleared?: number; unsupported?: boolean; error?: string } | undefined | null
  >;
  /**
   * Read the client's own scene gate table. Used by `/bncr stale orphans` to
   * find scenes the client still gates while the scene registry has no row.
   */
  listClientState?: () => Promise<BncrClientSceneStateList | undefined | null>;
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
  /** Derived: both clocks are quiet. Independent of any session anomaly. */
  quietByClock: boolean;
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
  const quietByClock = rowQuiet && sessionQuiet;
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
    quietByClock,
    // A deleted/archived host session is a cleanup candidate regardless of the
    // row clock; otherwise fall back to the 72h quiet rule. An unreadable store
    // is never proof of death, so it is never stale.
    stale: !sessionUnknown && (sessionAnomaly !== null || quietByClock),
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
    sessionText = `archived ${formatClock(archivedAt)} (${formatAge(archivedAt, now)})`;
  } else {
    sessionText = `${formatClock(row.sessionAt)} (${formatAge(row.sessionAt, now)})`;
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
  quietLabel: string,
  wantAnomalies: boolean,
): string {
  const headerBase =
    filter === 'missing' || filter === 'archived'
      ? '🧹 Stale scenes'
      : wantAnomalies
        ? `🧹 Stale scenes — quiet ${quietLabel}+ or session missing/archived`
        : `🧹 Stale scenes — quiet ${quietLabel}+ (clock only)`;
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
      if (label && label !== sceneKey) lines.push(`  ${label}`);
      for (const row of shown) lines.push(describeRow(row, now));
    } else {
      // Agents in one scene can carry different custom names; show each row's
      // own label instead of pretending they share one.
      for (const row of shown) {
        lines.push(describeRow(row, now));
        lines.push(`    label: ${formatStaleSceneLabel(row.scene)}`);
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

/**
 * 场景归一：客户端的 super gate state（mode / occ）只有一份，键是
 * `state:<平台:群:用户>`，没有 agent 维度。所以只有在「这个场景已经没有任何
 * agent 行」时才允许清它；还有一个 agent 行在用，就整条留下——否则删掉 A 会把
 * B 的门控状态一起清掉。
 */
export function partitionClientStateByScene(
  sceneRegistry: Map<string, BncrSceneRecord>,
  sceneKeys: Iterable<string>,
): { clear: string[]; keep: string[] } {
  const stillBound = new Set<string>();
  for (const scene of sceneRegistry.values()) {
    stillBound.add(normalizeToken(scene.sceneKey));
  }
  const clear: string[] = [];
  const keep: string[] = [];
  const seen = new Set<string>();
  for (const raw of sceneKeys) {
    const key = normalizeToken(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    (stillBound.has(key) ? keep : clear).push(key);
  }
  return { clear, keep };
}

/** One wording for the client-state outcome, single prune and batch alike. */
function describeClientClear(
  result:
    | { ok?: boolean; cleared?: number; unsupported?: boolean; error?: string }
    | undefined
    | null,
): string {
  if (result?.unsupported) {
    return 'Client state not cleared: the connected Bncr client is too old to expose bncr.state.clear.';
  }
  if (result?.ok === false) {
    return `Client state clear failed: ${String(result.error || 'unknown error')}`;
  }
  return `Client state cleared: ${String(result?.cleared ?? 0)} key(s).`;
}

async function clearClientStateForScenes(
  sceneKeys: string[],
  deps: StaleScenesDeps,
  keep: string[],
): Promise<string> {
  const keptNote =
    keep.length > 0
      ? 'Client state kept for ' +
        String(keep.length) +
        ' scene(s) with another agent row still in use: ' +
        keep.join(', ') +
        '.'
      : '';
  const joinNotes = (note: string) =>
    keptNote && note ? `${keptNote}\n${note}` : keptNote || note;
  if (sceneKeys.length === 0) {
    if (keptNote) return keptNote;
    return deps.clearClientState === undefined
      ? 'Client state skipped: no Bncr client RPC available.'
      : '';
  }
  if (!deps.clearClientState) {
    return joinNotes('Client state skipped: no Bncr client RPC available.');
  }
  try {
    const cleared = await deps.clearClientState(sceneKeys);
    return joinNotes(describeClientClear(cleared));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An older client answers an unknown method with "method not found"; that is
    // a version gap, not a failed cleanup, so it reads differently.
    return joinNotes(
      /method not found/i.test(message)
        ? 'Client state not cleared: the connected Bncr client is too old to expose bncr.state.clear.'
        : `Client state clear failed: ${message}`,
    );
  }
}

/** A chat message cannot carry an unbounded list; older scenes drop off first. */
const MAX_ORPHAN_SCENES = 50;

function describeOrphanState(entry: BncrClientSceneStateEntry, now: number): string {
  const parts: string[] = [entry.enabled === true ? 'gate on' : 'gate off'];
  const rev = Number(entry.rev || 0);
  if (Number.isFinite(rev) && rev > 0) {
    parts.push(
      (entry.enabled === true ? 'opened ' : 'last rev ') +
        formatClock(rev) +
        ' (' +
        formatAge(rev, now) +
        ')',
    );
  }
  const mode = normalizeToken(entry.mode).toLowerCase();
  parts.push(`mode ${mode || 'unset'}`);
  return `  ${parts.join(' · ')}`;
}

/**
 * 反向核对：客户端 state 表有、场景表没有的场景。
 *
 * 只读。多出来的条目只有两种来历——超级门控（oc/occ）已经打开但消息还没进
 * 场景表；或者场景行已经被清掉、客户端那份留了下来。该不该清理由操作者判断，
 * 这里不删任何东西。
 */
async function listOrphanClientStates(deps: StaleScenesDeps): Promise<StaleScenesResult> {
  const title = '🧩 Orphan client state';
  const tooOld =
    'The connected Bncr client is too old to expose bncr.state.list; update openclawclient and reload it.';
  if (!deps.listClientState) {
    return {
      ok: false,
      text: `${title}\n\nNo Bncr client RPC available: the client gate table cannot be read.`,
    };
  }
  let listed: BncrClientSceneStateList | undefined | null;
  try {
    listed = await deps.listClientState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text:
        title +
        '\n\n' +
        (/method not found/i.test(message) ? tooOld : `Client gate read failed: ${message}`),
    };
  }
  if (listed?.unsupported) return { ok: false, text: `${title}\n\n${tooOld}` };
  if (listed && listed.ok === false) {
    return {
      ok: false,
      text: `${title}\n\nClient gate read failed: ${String(listed.error || 'unknown error')}`,
    };
  }

  const now = deps.now();
  // 场景表里出现过的大小写都算已占位：平台代号大小写不一致时不制造假孤儿。
  const bound = new Set<string>();
  for (const scene of deps.sceneRegistry.values()) {
    const key = normalizeToken(scene.sceneKey);
    if (key) bound.add(key.toLowerCase());
  }
  const entries = Array.isArray(listed?.entries) ? listed.entries : [];
  const orphans = entries.filter((entry) => {
    const key = normalizeToken(entry?.sceneKey);
    // 内部配置行不是会话，不参与比对。
    if (!key || isInternalSceneKey(key)) return false;
    return !bound.has(key.toLowerCase());
  });
  const invalid = Number(listed?.invalid || 0);
  const invalidNote = invalid > 0 ? `${invalid} unreadable state key(s) skipped.` : '';
  const counted = `${entries.length} state entr${entries.length === 1 ? 'y' : 'ies'}`;

  if (orphans.length === 0) {
    const lines = [
      title,
      '',
      entries.length === 0
        ? 'None: the client holds no scene gate state at all.'
        : `None: every client scene gate state has a scene row (${counted}).`,
    ];
    if (invalidNote) lines.push(invalidNote);
    return { ok: true, text: lines.join('\n') };
  }

  const sceneKeys: string[] = [];
  const byScene = new Map<string, BncrClientSceneStateEntry[]>();
  for (const entry of orphans) {
    const key = normalizeToken(entry.sceneKey);
    const bucket = byScene.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      byScene.set(key, [entry]);
      sceneKeys.push(key);
    }
  }

  const lines = [`${title} — client has, scene table has none`, `${orphans.length} of ${counted}`];
  if (invalidNote) lines.push(invalidNote);
  for (const sceneKey of sceneKeys.slice(0, MAX_ORPHAN_SCENES)) {
    lines.push('', sceneKey);
    for (const entry of byScene.get(sceneKey) || []) lines.push(describeOrphanState(entry, now));
  }
  if (sceneKeys.length > MAX_ORPHAN_SCENES) {
    lines.push('', `… ${sceneKeys.length - MAX_ORPHAN_SCENES} more scene(s) not shown.`);
  }
  lines.push(
    '',
    'Two ways a scene ends up here: the super gate (oc/occ) was switched on before any',
    'message reached the scene table, or the scene row is gone and the client kept its gate.',
    'Read-only: nothing was deleted. These scenes have no scene row, so /bncr prune has no',
    'row to target; /bncr prune state <SceneId> drops just the client gate for one scene.',
  );
  return { ok: true, text: lines.join('\n') };
}

/**
 * /bncr prune state <SceneId> [force]：场景表已经没有这一行时，只清客户端门控。
 * 场景行还在就不许走这条路，否则等于绕过 prune 的归档与清理。
 */
async function executePruneOrphanState(
  command: { sceneKey: string; force: boolean },
  deps: StaleScenesDeps,
): Promise<StaleScenesResult> {
  const title = '🧹 Prune client state';
  const tooOld =
    'The connected Bncr client is too old to expose the gate RPC; update openclawclient and reload it.';
  const sceneKey = normalizeToken(command.sceneKey);
  if (!sceneKey) return { ok: false, text: STALE_USAGE_TEXT };
  if (isInternalSceneKey(sceneKey)) {
    return {
      ok: false,
      text: `${title}\n\nNot a chat scene: ${sceneKey} is an internal config row.`,
    };
  }
  // 大小写按场景键比对：平台代号大小写在两边不一定一致。
  const rowsForScene = () =>
    Array.from(deps.sceneRegistry.values()).filter(
      (scene) => normalizeToken(scene.sceneKey).toLowerCase() === sceneKey.toLowerCase(),
    );
  const rows = rowsForScene();
  if (rows.length > 0) {
    return {
      ok: false,
      text: [
        `${title} — refused`,
        '',
        `Scene table still has ${rows.length} row(s) for ${sceneKey}.`,
        `Use /bncr prune ${sceneKey} [<agentId>] [force] to archive and delete them.`,
      ].join('\n'),
    };
  }
  if (!deps.listClientState || !deps.clearClientState) {
    return {
      ok: false,
      text:
        title +
        '\n\nThe connected Bncr client does not expose the gate RPC; update openclawclient and reload it.',
    };
  }

  let listed: BncrClientSceneStateList | undefined | null;
  try {
    listed = await deps.listClientState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text:
        title +
        '\n\n' +
        (/method not found/i.test(message) ? tooOld : `Client gate read failed: ${message}`),
    };
  }
  if (listed?.unsupported) return { ok: false, text: `${title}\n\n${tooOld}` };
  if (listed && listed.ok === false) {
    return {
      ok: false,
      text: `${title}\n\nClient gate read failed: ${String(listed.error || 'unknown error')}`,
    };
  }
  const entry = (Array.isArray(listed?.entries) ? listed.entries : []).find(
    (item) => normalizeToken(item?.sceneKey).toLowerCase() === sceneKey.toLowerCase(),
  );
  if (!entry) {
    return { ok: false, text: `${title}\n\nNo client gate state for ${sceneKey}.` };
  }

  const now = deps.now();
  const rev = Number(entry.rev || 0);
  // 刚开过的门控可能是「先开门后进消息」的超级门控，不是残留。
  const fresh =
    Number.isFinite(rev) && rev > 0 && now - rev < (deps.staleMs ?? BNCR_STALE_SCENE_MS);
  if (entry.enabled === true && fresh && !command.force) {
    return {
      ok: false,
      text: [
        `${title} — needs force`,
        '',
        sceneKey,
        describeOrphanState(entry, now),
        'A gate opened in the last 72h may be a super gate switched on before the first',
        'message arrived, so it is not treated as a leftover.',
        `Re-send with force: /bncr prune state ${sceneKey} force`,
      ].join('\n'),
    };
  }
  // 读门控到清门控之间可能有消息进来，把场景行建出来——那就不是孤儿了。
  if (rowsForScene().length > 0) {
    return {
      ok: false,
      text:
        title +
        ' — skipped\n\nA scene row appeared for ' +
        sceneKey +
        ' while the gate was being read; nothing was cleared.',
    };
  }

  let cleared:
    | { ok?: boolean; cleared?: number; unsupported?: boolean; error?: string }
    | null
    | undefined;
  try {
    cleared = await deps.clearClientState([sceneKey]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text:
        title +
        '\n\n' +
        (/method not found/i.test(message) ? tooOld : `Client gate clear failed: ${message}`),
    };
  }
  if (cleared?.unsupported) return { ok: false, text: `${title}\n\n${tooOld}` };
  if (cleared && cleared.ok === false) {
    return {
      ok: false,
      text: `${title}\n\nClient gate clear failed: ${String(cleared.error || 'unknown error')}`,
    };
  }
  const count = Number(cleared?.cleared ?? 0);
  if (count === 0) {
    return {
      ok: true,
      text: [
        `${title} — already gone`,
        '',
        sceneKey,
        describeOrphanState(entry, now),
        'The client reported 0 keys cleared; its gate state had already disappeared.',
      ].join('\n'),
    };
  }
  return {
    ok: true,
    text: [
      `${title} — done`,
      '',
      sceneKey,
      describeOrphanState(entry, now),
      'Cleared ' +
        String(count) +
        ' client gate key(s). The scene table had no row, so nothing was archived and no session was touched.',
    ].join('\n'),
  };
}

function formatPruned(
  pruned: StaleSceneRow[],
  now: number,
  skipped: string[],
  stateNote = '',
): string {
  const lines: string[] = [];
  if (pruned.length === 0) {
    lines.push('🧹 Nothing pruned: every target row moved after the listing.');
  } else {
    lines.push(`🧹 Pruned ${pruned.length} scene row(s)`);
    for (const row of pruned) {
      lines.push(
        '',
        normalizeToken(row.scene.sceneKey),
        `  ${formatStaleSceneLabel(row.scene)}`,
        describeRow(row, now).trim(),
      );
    }
  }
  if (skipped.length > 0) lines.push('', `Skipped (active again): ${skipped.join(', ')}`);
  if (stateNote) lines.push('', stateNote);
  return lines.join('\n');
}

export type StaleScenesResult = { ok: true; text: string } | { ok: false; text: string };

/** A batch reply cannot carry 50 three-line rows; list a readable prefix. */
const BATCH_REPORT_LINES = 20;

function formatBatchPruned(
  pruned: StaleSceneRow[],
  now: number,
  raced: string[],
  days: number,
  remaining: number,
  unreadable: number,
  stateNote: string,
): string {
  if (pruned.length === 0) {
    const lines = [`🧹 Batch prune — quiet ${String(days)}d+`, 'Nothing pruned.'];
    if (raced.length > 0) lines.push(`Skipped (active again): ${raced.join(', ')}`);
    if (unreadable > 0) lines.push(`${String(unreadable)} row(s) skipped: session unreadable`);
    return lines.join('\n');
  }
  const lines = [
    `🧹 Batch prune — quiet ${String(days)}d+`,
    `Deleted ${String(pruned.length)} scene row(s), transcript archived`,
  ];
  for (const row of pruned.slice(0, BATCH_REPORT_LINES)) {
    lines.push(
      '  ' +
        normalizeToken(row.scene.sceneKey) +
        '  ' +
        (row.agentId || '(unassigned)') +
        '  ' +
        formatAge(row.rowAt, now) +
        '  ' +
        formatStaleSceneLabel(row.scene, 20),
    );
  }
  if (pruned.length > BATCH_REPORT_LINES) {
    lines.push(`  … ${String(pruned.length - BATCH_REPORT_LINES)} more`);
  }
  if (stateNote) lines.push('', stateNote);
  if (raced.length > 0) lines.push('', `Skipped (active again): ${raced.join(', ')}`);
  if (unreadable > 0) lines.push('', `${String(unreadable)} row(s) skipped: session unreadable`);
  if (remaining > 0) {
    lines.push('', `… ${String(remaining)} more candidate(s); run it again.`);
  }
  return lines.join('\n');
}

/**
 * Batch prune: every scene row quiet <days>, oldest first.
 *
 * Each row follows the single-prune steps exactly, and the client is asked once
 * (not per row) to drop its own per-scene state, because a batch has no command
 * text the client could parse a SceneId out of.
 */
async function executeStaleScenesBatch(
  command: { days: number; force: boolean },
  deps: StaleScenesDeps,
): Promise<StaleScenesResult> {
  const windowMs = command.days * DAY_MS;
  const { rows, now } = await inspectAll({ ...deps, staleMs: windowMs });
  if (rows.length === 0) {
    return { ok: true, text: '🧹 No scene rows yet: nothing to clean up.' };
  }
  const quietByRow = (row: StaleSceneRow) => row.rowAt <= 0 || now - row.rowAt > windowMs;
  /**
   * A batch is stricter than a single prune on purpose.
   *
   * The single prune trusts a session anomaly (missing/archived) on its own,
   * because an operator aimed it at that one row. A sweep must never take a
   * chat the operator archived yesterday but still talks to: the scene row
   * itself has to be quiet for the whole window. An unreadable session proves
   * nothing, so it needs force.
   */
  const quietEnough = (row: StaleSceneRow): boolean => {
    if (!quietByRow(row)) return false;
    if (row.sessionUnknown) return command.force;
    if (row.sessionAnomaly !== null) return true;
    return row.sessionAt == null || now - row.sessionAt > windowMs;
  };
  const candidates = rows
    .filter((row) => quietEnough(row))
    .sort((left, right) => left.rowAt - right.rowAt);
  const unreadable = rows.filter((row) => row.sessionUnknown && !command.force).length;
  if (candidates.length === 0) {
    return {
      ok: true,
      text:
        '🧹 No scene row is quiet ' +
        String(command.days) +
        'd+' +
        (unreadable > 0 ? ` (${String(unreadable)} row(s) skipped: session unreadable)` : '') +
        '.',
    };
  }

  const pruned: StaleSceneRow[] = [];
  const raced: string[] = [];
  const prunedScenes = new Set<string>();
  for (const row of candidates.slice(0, BNCR_STALE_SCENE_BATCH_MAX)) {
    // A message may land between the listing and this loop; the registry holds
    // the live row, so a changed lastSeenAt means the chat woke up.
    const current = deps.sceneRegistry.get(
      buildAgentSceneRegistryKey(row.scene.sceneKey, row.agentId),
    );
    if (!current || Number(current.lastSeenAt) !== row.rowAt) {
      raced.push(`${normalizeToken(row.scene.sceneKey)}/${row.agentId || '(unassigned)'}`);
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
        // The scene row is the part that keeps the dead scene listed.
      }
    }
    try {
      await deps.purgeSessionState?.({
        sceneKey: normalizeToken(row.scene.sceneKey),
        agentId: row.agentId,
        sessionKey: row.sessionKey,
      });
    } catch {
      // Best effort; the row removal is the operator-visible outcome.
    }
    deleteSceneRecord(deps.sceneRegistry, row.scene.sceneKey, row.agentId);
    pruned.push(row);
    prunedScenes.add(normalizeToken(row.scene.sceneKey));
  }

  // 场景归一：只在整条场景已经没有 agent 行时才清客户端门控状态。
  const { clear, keep } = partitionClientStateByScene(deps.sceneRegistry, prunedScenes);
  const stateNote = await clearClientStateForScenes(clear, deps, keep);

  if (pruned.length > 0) deps.onSceneChange?.();

  const remaining = candidates.length - pruned.length - raced.length;
  return {
    ok: true,
    text: formatBatchPruned(pruned, now, raced, command.days, remaining, unreadable, stateNote),
  };
}

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

  if (command.action === 'orphans') return listOrphanClientStates(deps);

  if (command.action === 'list') {
    // A day threshold replaces the default clock for this listing only; the
    // candidate rules themselves stay identical.
    const days = command.days;
    const windowMs = days ? days * DAY_MS : (deps.staleMs ?? BNCR_STALE_SCENE_MS);
    const { rows, now } = await inspectAll({ ...deps, staleMs: windowMs });
    const quietLabel = days ? `${String(days)}d` : '72h';
    // Nothing has ever come in on this bridge: saying "every row moved within
    // 72h" would describe rows that do not exist.
    if (rows.length === 0) {
      return { ok: true, text: '🧹 No scene rows yet: nothing to clean up.' };
    }
    // Anomalies are an extra reason to be a candidate, never a reason to drop
    // one: the clock-only views keep the rows that are quiet on their own and
    // leave out the ones that only show up because a session went missing.
    const wantAnomalies =
      command.includeAnomalies !== false ||
      command.filter === 'missing' ||
      command.filter === 'archived';
    const stale = rows.filter((row) => row.stale && (wantAnomalies || row.quietByClock));
    // Rows this view leaves out only because their session is an anomaly: say
    // so, otherwise a UI-deleted session in a live chat looks merely absent.
    const hiddenAnomalies = wantAnomalies
      ? 0
      : rows.filter((row) => row.stale && !row.quietByClock).length;
    const hiddenNote =
      hiddenAnomalies > 0
        ? ` ${hiddenAnomalies} session anomaly row(s) not in this view: /bncr stale all`
        : '';
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
    // Only rows this window would otherwise judge hold up the list; an
    // unreadable session in a row that is not old enough yet is not skipped work.
    const unknown = rows.filter(
      (row) => row.sessionUnknown && (row.rowAt <= 0 || now - row.rowAt > windowMs),
    ).length;
    const unknownNote = unknown > 0 ? ` ${unknown} row(s) skipped: session unreadable.` : '';
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
            unknownNote +
            hiddenNote,
        };
      }
      return {
        ok: true,
        text:
          '🧹 No stale scenes: every row or its session moved within ' +
          quietLabel +
          '.' +
          unknownNote +
          hiddenNote,
      };
    }
    return {
      ok: true,
      text:
        formatStaleList(
          filtered,
          now,
          rows.length,
          command.filter,
          unknown,
          quietLabel,
          wantAnomalies,
        ) + (hiddenNote ? `\n${hiddenNote.trim()}` : ''),
    };
  }

  if (command.action === 'prune-batch') {
    return executeStaleScenesBatch(command, deps);
  }

  if (command.action === 'prune-state') {
    return executePruneOrphanState(command, deps);
  }

  const sceneKey = normalizeToken(command.sceneKey);
  const wantedAgent = normalizeToken(command.agentId);
  if (isInternalSceneKey(sceneKey)) {
    return { ok: false, text: `Not a chat scene: ${sceneKey} is an internal config row.` };
  }
  const matching = Array.from(deps.sceneRegistry.values()).filter(
    (scene) => normalizeToken(scene.sceneKey) === sceneKey,
  );
  if (matching.length === 0) return { ok: false, text: `Scene not found: ${sceneKey}` };

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
        `Refusing to prune ${sceneKey}: session activity could not be read`,
        ...unverified.map((row) => describeRow(row, now)),
        '',
        'Retry once the session store is readable, or force to delete anyway: /bncr prune ' +
          sceneKey +
          (wantedAgent ? ` ${wantedAgent}` : '') +
          ' force',
      ].join('\n'),
    };
  }

  const active = inspected.filter((row) => !row.stale);
  if (active.length > 0 && !command.force) {
    return {
      ok: false,
      text: [
        `Refusing to prune ${sceneKey}: still active within 72h`,
        ...active.map((row) => describeRow(row, now)),
        '',
        'Re-run with force to delete anyway: /bncr prune ' +
          sceneKey +
          (wantedAgent ? ` ${wantedAgent}` : '') +
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
      skipped.push(`${normalizeToken(row.scene.sceneKey)}/${row.agentId || '(unassigned)'}`);
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

  if (pruned.length > 0) deps.onSceneChange?.();
  // 同一条场景上若还有别的 agent 行，客户端那份场景级门控状态必须留着。
  const { clear, keep } = partitionClientStateByScene(
    deps.sceneRegistry,
    pruned.length > 0 ? [sceneKey] : [],
  );
  const stateNote = await clearClientStateForScenes(clear, deps, keep);
  return { ok: true, text: formatPruned(pruned, now, skipped, stateNote) };
}
