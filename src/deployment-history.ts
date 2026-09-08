import { store } from './store.js';
import { id, now } from './utils.js';
import type { Deployment, DeploymentEvent } from './types.js';

// A bounded operational history, not an immutable compliance audit log.
export const deploymentHistoryLimit = 1000;
export function recordDeploymentEvent(deployment: Deployment, action: DeploymentEvent['action'], previousVersionId: string | null) {
  const event: DeploymentEvent = {
    id: id('evt'), deploymentId: deployment.id, appId: deployment.appId, action,
    previousVersionId, versionId: deployment.versionId, status: deployment.status,
    artifactSha256: store.versions.find(v => v.id === deployment.versionId)?.codeSha256 ?? null,
    createdAt: now(),
  };
  store.deploymentEvents.push(event);
  deployment.lastEventId = event.id;
  const kept = store.deploymentEvents.reduce((n, e) => n + Number(e.deploymentId === deployment.id), 0);
  // Preserve global append order while removing only the oldest entries of this deployment.
  let remove = kept - deploymentHistoryLimit;
  if (remove > 0) store.deploymentEvents = store.deploymentEvents.filter(e => e.deploymentId !== deployment.id || remove-- <= 0);
  return event;
}
