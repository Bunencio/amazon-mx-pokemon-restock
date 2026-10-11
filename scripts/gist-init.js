#!/usr/bin/env node
/**
 * Crea el gist secreto que guardará el estado compartido e imprime el GIST_ID
 * para el .env del PC y los Secrets de GitHub Actions.
 *
 *   GIST_TOKEN=ghp_xxx npm run gist:init      (o con GIST_TOKEN en .env)
 *
 * El token debe ser un PAT CLÁSICO con único scope "gist".
 */
import { config } from '../src/services/config.js';
import { createEmptySharedState } from '../src/services/stateStore.js';
import { createStateGist } from '../src/services/gistStateStore.js';

async function main() {
  const token = config.state.gistToken || process.env.GH_TOKEN || '';
  if (!token) {
    console.error('Falta GIST_TOKEN (PAT clásico con scope "gist"). Créalo en https://github.com/settings/tokens/new?scopes=gist');
    return 1;
  }
  if (config.state.gistId) {
    console.log(`Ya hay un GIST_ID configurado (${config.state.gistId}). Bórralo del .env si quieres crear otro.`);
    return 0;
  }
  const { id, url, scopes } = await createStateGist({ token, fileName: config.state.gistFileName, apiUrl: config.github.apiUrl, initialState: createEmptySharedState() });
  console.log(`Gist creado: ${url}`);
  console.log(`Scopes del token: ${scopes || '(no reportados)'}`);
  console.log('\nAgrega al .env del PC y a los Secrets del repo:');
  console.log(`  GIST_ID=${id}`);
  console.log('  GIST_TOKEN=<el mismo PAT>');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`gist:init falló: ${err.message}`);
    process.exit(1);
  });
