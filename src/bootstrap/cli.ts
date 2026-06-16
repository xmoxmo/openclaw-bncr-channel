import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { BncrConfigSchema } from '../core/config-schema.ts';
import {
  getOpenClawRuntimeConfig,
  mutateOpenClawRuntimeConfigFile,
} from '../openclaw/config-runtime.ts';

type BncrCliProgramLike = {
  command: (name: string) => BncrCliProgramLike;
  description: (text: string) => BncrCliProgramLike;
  action: (handler: () => Promise<void> | void) => BncrCliProgramLike;
};

type BncrCliRegistrarLike = {
  registerCli?: (
    register: (ctx: { program: BncrCliProgramLike }) => void,
    options?: { commands?: string[] },
  ) => void;
};

type BncrCliConfigRoot = {
  channels?: Record<string, unknown> & {
    bncr?: Record<string, unknown> & {
      enabled?: boolean;
      allowTool?: boolean;
    };
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export type BncrRegistrationApi = OpenClawPluginApi &
  BncrCliRegistrarLike & {
    registrationMode?: string;
    configSchema?: typeof BncrConfigSchema;
  };

export function registerBncrCli(api: BncrRegistrationApi) {
  if (typeof api.registerCli !== 'function') return;
  api.registerCli(
    ({ program }: { program: BncrCliProgramLike }) => {
      const bncr = program.command('bncr').description('Bncr channel utilities');
      bncr
        .command('miniconfig')
        .description(
          'Seed minimal channels.bncr config (adds enabled=true and allowTool=false only when missing)',
        )
        .action(async () => {
          const cfg = (getOpenClawRuntimeConfig(api) as BncrCliConfigRoot | null | undefined) || {};
          const channels = isPlainObject(cfg.channels) ? cfg.channels : {};
          const existing = isPlainObject(channels.bncr) ? channels.bncr : {};
          const added: string[] = [];

          if (existing.enabled === undefined) {
            added.push('enabled=true');
          }

          if (existing.allowTool === undefined) {
            added.push('allowTool=false');
          }

          if (added.length === 0) {
            console.log('Minimal bncr config already present. No changes made.');
            return;
          }

          await mutateOpenClawRuntimeConfigFile(api, {
            afterWrite: { mode: 'auto' },
            mutate(draft: Record<string, unknown>) {
              if (!isPlainObject(draft.channels)) draft.channels = {};
              const draftChannels = draft.channels as Record<string, unknown>;
              const draftExisting = isPlainObject(draftChannels.bncr) ? draftChannels.bncr : {};
              const draftBncrCfg: Record<string, unknown> = { ...draftExisting };

              if (draftBncrCfg.enabled === undefined) {
                draftBncrCfg.enabled = true;
              }

              if (draftBncrCfg.allowTool === undefined) {
                draftBncrCfg.allowTool = false;
              }

              draftChannels.bncr = draftBncrCfg;
            },
          });
          console.log('Seeded minimal bncr config at channels.bncr.');
          console.log(`Added missing fields: ${added.join(', ')}`);
          console.log('Gateway will apply the config using the host afterWrite policy.');
        });
    },
    { commands: ['bncr'] },
  );
}

export const shouldSkipNonRuntimeRegister = (mode?: string) =>
  mode === 'cli-metadata' || mode === 'discovery';
