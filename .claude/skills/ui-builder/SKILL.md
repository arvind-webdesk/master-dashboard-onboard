---
name: ui-builder
description: Build and maintain multi-step wizard forms for the internal onboarding tool. Use when the user says "build the form", "add a step to the wizard", "improve the onboarding UX", "wizard form", "stepper", or when modifying anything under src/app/onboard/_components/. Enforces non-technical-staff UX, React Hook Form + Zod patterns, and the shared design tokens.
---

# UI Builder Skill — Wizard Forms for Non-Technical Staff

You are building forms that **non-technical company staff** use to provision client dashboards. They are not developers. They have never seen a YAML file, a GitHub token, or a stack trace. The UX bar is: *"would a marketing assistant who has never used GitHub complete this without asking a question?"*

## Golden rules (never break these)

1. **Wizard, not a wall of fields.** Any form with more than ~6 inputs MUST be a stepped wizard. One logical concern per step. Never dump everything on one page.
2. **Validate per step, not at the end.** The user clicks "Next" → the current step's fields are validated → only advance if clean. Errors appear inline, under the field, never in a banner.
3. **Always show where you are.** A visible stepper ("Step 2 of 5 — Branding") lives at the top of every step. Each step has a title and a one-line subtitle explaining *why* this step exists.
4. **Back is free; Next is guarded.** Going back must never lose data. The previous step's values stay in React state. Going forward without passing validation must be impossible.
5. **Never autosubmit.** The final step is always a Review screen that shows every value and has a single explicit "Create dashboard" button. No multi-purpose "Submit / Continue" button that changes meaning.
6. **Confirmation before side effects.** Review → user reads summary → clicks primary button → confirmation modal → only then does the server action fire. Two clicks, not one.
7. **Error messages tell the user what to do.** "Please pick a color" ✅. "brandPrimaryColor regex failed" ❌. If the error is technical, the field label is wrong.
8. **No tooltips for core functionality.** If a field needs a tooltip to be understood, the label is wrong — rename it.
9. **Keyboard navigation works end to end.** Tab through every field, Enter on Next advances, Esc on a modal closes it.
10. **Never expose internal identifiers.** No GitHub token, no template URL, no repo ID, no Prisma error messages, no stack traces. The form's vocabulary is *client*, *dashboard*, *module*, *brand*. Not *repo*, *env var*, *token*.

## Step taxonomy (for the onboarding wizard)

The onboarding form is a **5-step wizard**. Each step is a self-contained React component under `src/app/onboard/_components/steps/`.

| # | Step | Purpose | Required fields |
|---|---|---|---|
| 1 | **Client** | "Who is this dashboard for?" | name, slug, industry, country, timezone |
| 2 | **Contact** | "Who's the main admin?" | adminName, adminEmail, adminPhone (optional) |
| 3 | **Branding** | "How should it look?" | brandPrimaryColor, brandSecondaryColor (opt), brandLogoUrl (opt), brandFaviconUrl (opt) |
| 4 | **Features** | "What's included?" | modules (≥1), planTier, userSeats, goLiveDate (opt), notes (opt) |
| 5 | **Review** | "Does this look right?" | — (read-only summary + confirm button) |

Never add a 6th step. If a new concern appears, slot it into one of the existing 5 or push it to a separate "post-provision settings" page.

## Architecture

```
src/app/onboard/_components/
├── OnboardForm.tsx              ← orchestrator; owns react-hook-form state
├── Stepper.tsx                  ← horizontal progress indicator
├── WizardNav.tsx                ← Back / Next / Create-dashboard buttons
├── ConfirmModal.tsx             ← pre-submit confirmation
├── steps/
│   ├── ClientStep.tsx
│   ├── ContactStep.tsx
│   ├── BrandingStep.tsx
│   ├── FeaturesStep.tsx
│   └── ReviewStep.tsx
├── fields/                      ← reusable field primitives
│   ├── Field.tsx                ← label + hint + error slot wrapper
│   ├── TextInput.tsx
│   ├── Select.tsx
│   ├── ColorPicker.tsx
│   ├── CheckboxGroup.tsx
│   └── DatePicker.tsx
├── ProgressPoller.tsx           ← after submit
└── ResultCard.tsx               ← terminal success/failure
```

## State shape

Use **React Hook Form** with a single top-level form instance. Steps read/write fields via `control` and `register` passed down as props. Never create a new `useForm()` per step — you will lose values on Back.

```ts
type OnboardFormValues = {
  // step 1
  name: string;
  slug: string;
  industry?: string;
  country?: string;
  timezone: string;

  // step 2
  adminName: string;
  adminEmail: string;
  adminPhone?: string;

  // step 3
  brandPrimaryColor: string;
  brandSecondaryColor?: string;
  brandLogoUrl?: string;
  brandFaviconUrl?: string;

  // step 4
  enabledModules: Record<string, boolean>;  // keyed by module key for easier registration
  planTier: 'starter' | 'pro' | 'enterprise';
  userSeats: number;
  goLiveDate?: string;                      // ISO date string (yyyy-mm-dd)
  notes?: string;
};
```

## Per-step validation pattern

Validate only the fields that belong to the current step when the user clicks Next. Use `trigger()` from React Hook Form:

```ts
async function handleNext() {
  const fieldsForThisStep = STEP_FIELDS[currentStep];
  const valid = await trigger(fieldsForThisStep);
  if (valid) setCurrentStep((s) => s + 1);
}
```

Never call `handleSubmit` until the Review step. `handleSubmit` belongs to the "Create dashboard" button only.

## Styling conventions

- Tailwind. No custom CSS files.
- Card: `rounded-xl border border-surface-border bg-white p-6 shadow-sm`
- Input: `block w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500`
- Primary button: `rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50`
- Secondary button: `rounded-lg border border-surface-border bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-surface-muted`
- Error text: `mt-1 text-xs text-red-600`
- Hint text: `mt-0.5 text-xs text-gray-500`
- Stepper: horizontal, one-line, current step bold + colored, completed steps show a check, upcoming steps grey.

## Required behaviors checklist

When building or reviewing a wizard step, tick all of these:

- [ ] Step has a title and a one-line subtitle.
- [ ] Stepper at top shows current position out of total.
- [ ] Every required field has a clear label and a plain-language error message.
- [ ] Optional fields are marked "(optional)" in the label.
- [ ] Back button works and preserves all entered data.
- [ ] Next button is disabled when the step is invalid.
- [ ] On the last step, a full summary is shown before the confirm button.
- [ ] Submit triggers a confirmation modal, not an immediate provision.
- [ ] Submit button is disabled while the request is in flight.
- [ ] No raw field errors from React Hook Form leak through — wrap in the `Field` component.
- [ ] Non-technical staff would understand every word on the screen.

## Delegation

The form NEVER calls GitHub or git directly. On final submit, it calls the server action `startProvisioning` in `src/app/onboard/actions.ts`, which delegates to `ProvisioningService.create()`. Progress is shown by the `ProgressPoller` component via the `/api/provision/:id/status` endpoint.

## When asked to add a new field

1. Ask yourself: *does a non-technical staff member actually know this answer at onboarding time?* If not, refuse and suggest adding it to the template's post-deploy settings page instead.
2. Pick the step it belongs to — do not create a new step just for one field.
3. Add it to: the Prisma `Client` model, the `OnboardFormValues` type, the step component, the Zod schema in `actions.ts`, the `SeedData` shape in `TemplateCloner.ts`, and the Review step summary.
4. If it's optional, default it to `undefined` in `defaultValues` and never mark it red.
5. Run the prisma migration and restart dev.

## When the wizard breaks

Common failure modes and the fix:

| Symptom | Cause | Fix |
|---|---|---|
| Clicking Next does nothing | `trigger()` called on fields not registered in the current step | Verify `STEP_FIELDS` matches what the step actually renders |
| Values reset on Back | Step created its own `useForm()` | Lift the form instance to `OnboardForm.tsx`, pass `control` down |
| Validation passes but submit fails server-side | Zod schema in `actions.ts` drifted from the form | Regenerate types; keep `actions.ts` schema as the source of truth |
| Stepper shows old step after submit | Progress UI rendered above the wizard and the wizard wasn't unmounted | Unmount the wizard on submit and mount `<ProgressPoller/>` in its place |
