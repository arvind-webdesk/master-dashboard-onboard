import { EventEmitter } from 'node:events';

/**
 * Typed event emitter for provisioning lifecycle events.
 *
 * Kept deliberately simple — subscribers live in-process (for now).
 * When we add email/Slack notifications, they subscribe here.
 */

export interface ClientProvisionedEvent {
  type: 'ClientProvisioned';
  clientId: string;
  slug: string;
  githubRepoUrl: string;
  commitSha: string;
  provisionedBy: string;
}

export interface ClientProvisioningFailedEvent {
  type: 'ClientProvisioningFailed';
  clientId: string;
  slug: string;
  step: string;
  referenceId: string;
  provisionedBy: string;
}

export type ProvisioningEvent = ClientProvisionedEvent | ClientProvisioningFailedEvent;

class TypedEmitter {
  private inner = new EventEmitter();

  emit(event: ProvisioningEvent): void {
    this.inner.emit(event.type, event);
  }

  on<T extends ProvisioningEvent['type']>(
    type: T,
    listener: (event: Extract<ProvisioningEvent, { type: T }>) => void,
  ): void {
    this.inner.on(type, listener as (e: ProvisioningEvent) => void);
  }
}

export const events = new TypedEmitter();
