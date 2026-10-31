import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';

/**
 * Direct chats are filed under one fixed sidebar group. The owner can point a
 * single direct scene somewhere else with `/bncr group set`, but clearing the
 * override always lands back here. Where that section sits in the sidebar, and
 * whether it exists in the host catalog at all, is the host's business.
 */
export const BNCR_DIRECT_SESSION_CATEGORY = '私聊';

/** Separator used between platform, name and id inside a session label. */
export const BNCR_SESSION_LABEL_SEPARATOR = '·';

/** Upper bound for the operator-visible part of a label. */
export const BNCR_SESSION_NAME_MAX_CHARS = 32;

export type BncrSceneIdentity = {
  customName?: string;
  category?: string;
};

/**
 * Invisible separators that would make two different names look identical in
 * the sidebar. Zero-width joiner is deliberately kept: emoji sequences need it.
 */
const BNCR_INVISIBLE_CHARS = new Set([0x200b, 0x2060, 0xfeff, 0x00ad]);

/**
 * Flatten a name into something that fits on one sidebar row: control characters
 * and newlines collapse to spaces, the label separator cannot appear inside a
 * name, and over-long names are truncated with an ellipsis.
 */
export function sanitizeBncrDisplayName(
  raw: unknown,
  maxChars: number = BNCR_SESSION_NAME_MAX_CHARS,
): string | null {
  const limit = Number.isFinite(maxChars) && maxChars >= 4 ? Math.floor(maxChars) : 32;
  const flattened = Array.from(String(raw ?? ''))
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (BNCR_INVISIBLE_CHARS.has(code)) return '';
      return code < 0x20 || code === 0x7f ? ' ' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flattened) return null;
  const cleaned = flattened.split(BNCR_SESSION_LABEL_SEPARATOR).join('-').trim();
  if (!cleaned) return null;
  // Count code points, so emoji and other astral characters are never cut in half.
  const characters = Array.from(cleaned);
  if (characters.length <= limit) return cleaned;
  return `${characters.slice(0, limit - 1).join('')}…`;
}

/**
 * Build the operator-visible session label for a scene.
 *
 * Custom name wins outright and drops the id: an operator who named a scene
 * already knows which one it is. Automatic labels keep the id so two chats with
 * the same display name stay distinguishable.
 */
export function formatBncrSceneLabel(args: {
  platform: string;
  id?: string;
  name?: string;
  customName?: string;
  maxNameChars?: number;
}): string | null {
  // A platform carrying the separator would read as an extra label segment.
  const platform = String(args.platform ?? '')
    .split(BNCR_SESSION_LABEL_SEPARATOR)
    .join('-')
    .trim();
  if (!platform) return null;
  const maxChars = args.maxNameChars ?? BNCR_SESSION_NAME_MAX_CHARS;
  const separator = BNCR_SESSION_LABEL_SEPARATOR;
  // Spacing keeps 平台 · 名称 · id readable at sidebar width; the bare dot is
  // still what a typed name cannot contain.
  const join = ` ${separator} `;

  const custom = sanitizeBncrDisplayName(args.customName, maxChars);
  if (custom) return `${platform}${join}${custom}`;

  const id = String(args.id ?? '').trim();
  const name = sanitizeBncrDisplayName(args.name, maxChars);
  if (name && id && name === id) return `${platform}${join}${name}`;
  if (name && id) return `${platform}${join}${name}${join}${id}`;
  if (name) return `${platform}${join}${name}`;
  if (id) return `${platform}${join}${id}`;
  return platform;
}

/**
 * Scene identity is shared by every agent watching the same chat: the sidebar
 * name and the group belong to the scene, not to one agent's session row.
 * Each field is taken from the freshest row that defines it.
 */
export function resolveBncrSceneIdentity(
  registry: ReadonlyMap<string, BncrSceneRecord>,
  sceneKey: string,
  agentId?: string | null,
): BncrSceneIdentity {
  const key = String(sceneKey ?? '').trim();
  if (!key) return {};
  const agent = String(agentId ?? '').trim();
  let agentRow: BncrSceneRecord | undefined;
  let newestName: { value: string; at: number } | null = null;
  let newestCategory: { value: string; at: number } | null = null;
  for (const record of registry.values()) {
    if (String(record.sceneKey ?? '').trim() !== key) continue;
    if (agent && String(record.agentId ?? '').trim() === agent) agentRow = record;
    const at = Number.isFinite(record.lastSeenAt) ? record.lastSeenAt : 0;
    const name = String(record.customName ?? '').trim();
    if (name && (!newestName || at >= newestName.at)) newestName = { value: name, at };
    const category = String(record.category ?? '').trim();
    if (category && (!newestCategory || at >= newestCategory.at)) {
      newestCategory = { value: category, at };
    }
  }
  // An explicit per-agent value wins for that agent; otherwise the scene-wide
  // value applies, which is what an agentId-less write produces.
  const agentName = String(agentRow?.customName ?? '').trim();
  const agentCategory = String(agentRow?.category ?? '').trim();
  return {
    ...(agentName ? { customName: agentName } : newestName ? { customName: newestName.value } : {}),
    ...(agentCategory
      ? { category: agentCategory }
      : newestCategory
        ? { category: newestCategory.value }
        : {}),
  };
}

/**
 * A scene id is 平台:id. The platform half is ASCII by construction, which keeps
 * free-text names such as 项目:二期 from being mistaken for a target.
 */
export function isBncrSceneIdToken(token: unknown): boolean {
  const raw = String(token ?? '').trim();
  if (!raw || /\s/.test(raw)) return false;
  return /^[A-Za-z][A-Za-z0-9_-]*:.+$/.test(raw);
}

export type BncrSceneTargets = { sceneKey?: string; agentId?: string };

/**
 * Every scene setting accepts the same optional tail: `[<agentId>] [<SceneId>]`.
 * One token may be either; two tokens must be one of each; anything longer is a
 * usage error so a forgotten separator cannot silently pick the wrong target.
 */
export function parseBncrSceneTargets(tokens: readonly string[]): BncrSceneTargets | null {
  const items = tokens.map((token) => String(token ?? '').trim()).filter(Boolean);
  if (items.length > 2) return null;
  const sceneKey = items.find((token) => isBncrSceneIdToken(token));
  const agentId = items.find((token) => !isBncrSceneIdToken(token));
  if (items.length === 2 && (!sceneKey || !agentId)) return null;
  return {
    ...(sceneKey ? { sceneKey } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * Category this scene's session must live in.
 *
 * Direct chats always belong to 私聊. Group chats return null when the operator
 * set nothing, which actively clears any earlier override so the scene falls
 * back to the host default instead of keeping a stale group.
 */
export function resolveBncrSessionCategory(args: {
  kind: 'direct' | 'group';
  identity?: BncrSceneIdentity;
}): string | null {
  const category = String(args.identity?.category ?? '').trim();
  if (category) return category;
  return args.kind === 'direct' ? BNCR_DIRECT_SESSION_CATEGORY : null;
}
