import type { Module, ModuleSource } from './module-source';

/**
 * StaticModuleSource — hard-coded module list for Phase 1 MVP.
 *
 * Keys match the module keys in the dashboard template's
 * `lib/client-config.ts` ENABLED_MODULES set. The template's Sidebar filters
 * nav items by `isModuleEnabled(moduleKey)`, and `apply-config.ts` rewrites
 * that set from the `modules` array in seed-data.json.
 *
 * NOTE: "dashboard" is always enabled in the template and is NOT listed here —
 * it is not user-selectable.
 *
 * When a new module is added to the template, add it here AND to the
 * /provision-client skill's "Available modules" section.
 */
const STATIC_MODULES: Module[] = [
  {
    key: 'users',
    displayName: 'Users',
    description: 'View, add, edit, and deactivate user accounts.',
  },
  {
    key: 'roles',
    displayName: 'Roles & Permissions',
    description: 'Manage user roles and module-level permissions.',
  },
  {
    key: 'email-templates',
    displayName: 'Email Templates',
    description: 'Manage and send transactional email templates.',
  },
  {
    key: 'activity-logs',
    displayName: 'Activity Logs',
    description: 'Audit trail of user actions across the dashboard.',
  },
  {
    key: 'api-logs',
    displayName: 'API Logs',
    description: 'Request/response log for outbound API calls.',
  },
  {
    key: 'settings',
    displayName: 'System Settings',
    description: 'Dashboard-wide configuration and preferences.',
  },
  {
    key: 'import-export',
    displayName: 'Import/Export',
    description: 'Bulk import and export data across supported modules (CSV/Excel).',
  },
  {
    key: 'cron',
    displayName: 'Cron',
    description: 'Schedule and monitor background jobs and recurring tasks.',
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
