import { readBooleanParam as sdkReadBooleanParam } from 'openclaw/plugin-sdk/boolean-param';
import {
  applyAccountNameToChannelSection as sdkApplyAccountNameToChannelSection,
  jsonResult as sdkJsonResult,
  setAccountEnabledInConfigSection as sdkSetAccountEnabledInConfigSection,
} from 'openclaw/plugin-sdk/core';
import {
  readJsonFileWithFallback as sdkReadJsonFileWithFallback,
  writeJsonFileAtomically as sdkWriteJsonFileAtomically,
} from 'openclaw/plugin-sdk/json-store';
import { readStringParam as sdkReadStringParam } from 'openclaw/plugin-sdk/param-readers';
import { createDefaultChannelRuntimeState as sdkCreateDefaultChannelRuntimeState } from 'openclaw/plugin-sdk/status-helpers';
import { extractToolSend as sdkExtractToolSend } from 'openclaw/plugin-sdk/tool-send';

export const readOpenClawBooleanParam = sdkReadBooleanParam;
export const readOpenClawStringParam = sdkReadStringParam;
export const readOpenClawJsonFileWithFallback = sdkReadJsonFileWithFallback;
export const writeOpenClawJsonFileAtomically = sdkWriteJsonFileAtomically;
export const createOpenClawDefaultChannelRuntimeState = sdkCreateDefaultChannelRuntimeState;
export const extractOpenClawToolSend = sdkExtractToolSend;
export const openClawJsonResult = sdkJsonResult;
export const applyOpenClawAccountNameToChannelSection = sdkApplyAccountNameToChannelSection;
export const setOpenClawAccountEnabledInConfigSection = sdkSetAccountEnabledInConfigSection;
