import { buildOpenClawChannelRuntimeSurfaceDiagnostics } from '../openclaw/runtime-surface.ts';

export function createBncrBridgeRuntimeSurfaceFacade(runtime: { getApi: () => unknown }) {
  return {
    buildRuntimeSurfaceDiagnostics: () =>
      buildOpenClawChannelRuntimeSurfaceDiagnostics(runtime.getApi()),
  };
}
