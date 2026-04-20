import type { Module, ModuleSource } from './module-source';

/**
 * StaticModuleSource — hard-coded module list for Phase 1 MVP.
 *
 * Keys match the `isAble` permission strings used by the dashboard template's
 * navigation config. This is the contract between the onboarding tool and the
 * template's seed.ts: each key here should correspond to a row in the
 * template's ModuleEnablement table, and the template's navigation shows or
 * hides items by checking `isAble` against the enabled module keys.
 *
 * NOTE: "Dashboard" (isAble: '*') is always enabled in the template and is
 * NOT listed here — it is not user-selectable.
 *
 * When a new module is added to the template, add it here AND to the
 * /provision-client skill's "Available modules" section.
 */
const STATIC_MODULES: Module[] = [
  {
    key: 'users-list-view',
    displayName: 'Users List',
    description: 'View, add, edit, and delete user accounts.',
  },
  {
    key: 'role-management-view',
    displayName: 'Roles & Permissions',
    description: 'Manage user roles and module-level permissions.',
  },
  {
    key: 'setting-management-view',
    displayName: 'Settings',
    description: 'Account and dashboard settings.',
  },
  {
    key: 'logs-management-view',
    displayName: 'Activity Logs',
    description: 'View audit logs for user and system actions.',
  },
  {
    key: 'email-management-view',
    displayName: 'Email Templates',
    description: 'Manage transactional email templates (currently optional).',
  },
  {
    key: 'helps-management-view',
    displayName: 'Help Center',
    description: 'In-app help articles and documentation (currently optional).',
  },
];

export class StaticModuleSource implements ModuleSource {
  async list(): Promise<Module[]> {
    return STATIC_MODULES;
  }
}

export const defaultModuleSource: ModuleSource = new StaticModuleSource();

/** Validate that every key in `selected` exists in the source. */
export async function assertKnownModules(selected: string[]): Promise<void> {
  const all = await defaultModuleSource.list();
  const known = new Set(all.map((m) => m.key));
  const unknown = selected.filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(`[modules] Unknown module keys: ${unknown.join(', ')}`);
  }
}
