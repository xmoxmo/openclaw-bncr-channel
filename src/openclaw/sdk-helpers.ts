import { access } from 'node:fs/promises';
import {
  applyAccountNameToChannelSection as sdkApplyAccountNameToChannelSection,
  jsonResult as sdkJsonResult,
  setAccountEnabledInConfigSection as sdkSetAccountEnabledInConfigSection,
} from 'openclaw/plugin-sdk/core';
import {
  loadJsonFile as sdkLoadJsonFile,
  writeJsonFileAtomically as sdkWriteJsonFileAtomically,
} from 'openclaw/plugin-sdk/json-store';
import { readStringParam as sdkReadStringParam } from 'openclaw/plugin-sdk/param-readers';
import { createDefaultChannelRuntimeState as sdkCreateDefaultChannelRuntimeState } from 'openclaw/plugin-sdk/status-helpers';
import type { ChannelToolSend } from 'openclaw/plugin-sdk/tool-send';
import { extractToolSend as sdkExtractToolSend } from 'openclaw/plugin-sdk/tool-send';

export type OpenClawChannelToolSend = ChannelToolSend;

export const readOpenClawStringParam = sdkReadStringParam;
export async function readOpenClawJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  const value = sdkLoadJsonFile<T>(filePath);
  if (value !== undefined) return { value, exists: true };
  try {
    await access(filePath);
    return { value: fallback, exists: true };
  } catch {
    return { value: fallback, exists: false };
  }
}
export const writeOpenClawJsonFileAtomically = sdkWriteJsonFileAtomically;
export const createOpenClawDefaultChannelRuntimeState = sdkCreateDefaultChannelRuntimeState;
export const extractOpenClawToolSend = (
  args: Record<string, unknown>,
  fallbackAction?: string,
): ChannelToolSend | null =>
  (sdkExtractToolSend(args, fallbackAction) as ChannelToolSend | null) || null;
export const openClawJsonResult = sdkJsonResult;
export const applyOpenClawAccountNameToChannelSection = sdkApplyAccountNameToChannelSection;
export const setOpenClawAccountEnabledInConfigSection = sdkSetAccountEnabledInConfigSection;
