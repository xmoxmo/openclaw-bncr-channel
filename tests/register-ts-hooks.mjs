import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      specifier.endsWith('.js') &&
      context.parentURL?.startsWith('file:')
    ) {
      const parentPath = fileURLToPath(context.parentURL);
      const candidate = path.resolve(path.dirname(parentPath), specifier.replace(/\.js$/i, '.ts'));
      if (fs.existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
