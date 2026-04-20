/**
 * ModuleSource abstraction — the form and the provisioner read the list of
 * available modules through this interface, not by importing the concrete
 * module list directly.
 *
 * Phase 1 ships `StaticModuleSource` (hard-coded in modules.ts). A later phase
 * can add a `TemplateModuleSource` that reads a file from the cloned template.
 */

export interface Module {
  /** Machine-readable key; must be URL-safe and stable. */
  key: string;
  /** Human-facing label shown in the onboarding form. */
  displayName: string;
  /** One-line description shown next to the checkbox. */
  description: string;
}

export interface ModuleSource {
  list(): Promise<Module[]>;
}
