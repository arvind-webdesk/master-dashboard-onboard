'use client';

import { forwardRef } from 'react';

/**
 * Reusable field primitives for the onboarding wizard.
 *
 * Every form input goes through <Field> so the label / hint / error layout is
 * identical everywhere. Never bypass this wrapper — even a one-off input on a
 * custom step should use it.
 */

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-800">
        {label}
        {!required ? <span className="ml-1 text-gray-400">(optional)</span> : null}
      </label>
      {hint ? <p className="mt-0.5 text-xs text-gray-500">{hint}</p> : null}
      <div className="mt-1.5">{children}</div>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

const inputClass =
  'block w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-60';

export const TextInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function TextInput(props, ref) {
  return <input ref={ref} {...props} className={`${inputClass} ${props.className ?? ''}`} />;
});

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea(props, ref) {
  return <textarea ref={ref} {...props} className={`${inputClass} ${props.className ?? ''}`} />;
});

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }
>(function Select(props, ref) {
  return (
    <select ref={ref} {...props} className={`${inputClass} ${props.className ?? ''}`}>
      {props.children}
    </select>
  );
});

export function PrimaryButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 ${rest.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`rounded-lg border border-surface-border bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50 ${rest.className ?? ''}`}
    >
      {children}
    </button>
  );
}

/**
 * Stepper — horizontal step indicator rendered above every wizard step.
 * Completed steps get a check, the current step is bold/colored, upcoming
 * steps are muted.
 */
export function Stepper({
  steps,
  current,
}: {
  steps: { key: string; label: string }[];
  current: number;
}) {
  return (
    <ol className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => {
        const isDone = i < current;
        const isCurrent = i === current;
        const dotClass = isDone
          ? 'bg-green-600 text-white'
          : isCurrent
            ? 'bg-gray-900 text-white ring-4 ring-gray-900/10'
            : 'bg-gray-200 text-gray-500';
        const textClass = isCurrent
          ? 'font-semibold text-gray-900'
          : isDone
            ? 'text-gray-600'
            : 'text-gray-400';
        return (
          <li key={s.key} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] ${dotClass}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {isDone ? '✓' : i + 1}
            </span>
            <span className={`hidden truncate sm:inline ${textClass}`}>{s.label}</span>
            {i < steps.length - 1 ? (
              <span
                className={`mx-1 hidden h-px flex-1 sm:block ${isDone ? 'bg-green-600' : 'bg-gray-200'}`}
                aria-hidden
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * StepShell — per-step card wrapper with title, subtitle, stepper, and a
 * consistent content slot. Every step renders inside one of these.
 */
export function StepShell({
  title,
  subtitle,
  stepIndex,
  stepTotal,
  children,
}: {
  title: string;
  subtitle: string;
  stepIndex: number;
  stepTotal: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        Step {stepIndex + 1} of {stepTotal}
      </p>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-gray-600">{subtitle}</p>
      </div>
      <div className="space-y-5">{children}</div>
    </div>
  );
}
