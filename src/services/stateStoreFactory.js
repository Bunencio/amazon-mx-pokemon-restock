import { resolveStateBackend } from './config.js';
import { GistStateStore } from './gistStateStore.js';
import { GitHubArtifactStateStore } from './githubArtifactStateStore.js';
import { JsonFileStore, normalizeRunnerState, normalizeSharedState } from './stateStore.js';

/** Shared state: gist (both runners) → artifact (Actions only) → local file. */
export function createSharedStore(config, logger) {
  const backend = resolveStateBackend(config);
  if (backend === 'gist') {
    return new GistStateStore({
      gistId: config.state.gistId,
      token: config.state.gistToken,
      fileName: config.state.gistFileName,
      apiUrl: config.github.apiUrl,
      localFallbackPath: config.state.sharedFile,
      logger,
    });
  }
  if (backend === 'artifact') {
    return new GitHubArtifactStateStore({
      apiUrl: config.github.apiUrl,
      repository: config.github.repository,
      token: config.github.token,
      artifactName: config.state.artifactName,
      localFilePath: config.state.sharedFile,
      logger,
    });
  }
  return new JsonFileStore(config.state.sharedFile, { logger, normalize: normalizeSharedState, backend: 'local-file' });
}

/** Runner-local state (session, backoff, budget) always lives on this machine. */
export function createRunnerStore(config, logger) {
  return new JsonFileStore(config.state.runnerFile, {
    logger,
    normalize: (raw) => normalizeRunnerState(raw, config.runnerId),
    backend: 'local-file',
  });
}
