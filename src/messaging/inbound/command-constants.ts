/**
 * Shared command-layer constants.
 *
 * Kept in a leaf module (no imports) so the registry, the scene-admin
 * executor and the session-identity executor can all reference the same
 * string without creating an import cycle.
 */
export const ADMIN_REQUIRED_TEXT = 'Admin permission required.';

/** Single source for the stale filters: parse, usage, help and the help label. */
export const STALE_SCENES_FILTERS = ['all', 'swapped', 'solo', 'missing', 'archived'] as const;
