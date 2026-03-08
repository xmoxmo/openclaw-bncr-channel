import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const parentPath = fileURLToPath(context.parentURL);
      const candidate = path.resolve(path.dirname(parentPath), specifier.replace(/\.js$/i, '.ts'));
      if (fs.existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
