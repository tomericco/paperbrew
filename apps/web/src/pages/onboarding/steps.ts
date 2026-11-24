/** The onboarding steps in flow order. Steps 1 to 5 (gmail to printer) show "Step n of 5" dots. */
export type Step = 'welcome' | 'gmail' | 'look' | 'first' | 'schedule' | 'printer' | 'done';

export const STEP_ORDER: Step[] = ['welcome', 'gmail', 'look', 'first', 'schedule', 'printer', 'done'];

export const DOT_COUNT = 5;

/** What every card receives from the flow. */
export type CardProps = { next(): void; back(): void };

const STORAGE_KEY = 'pb.onboarding.step';

export function isStep(value: unknown): value is Step {
  return typeof value === 'string' && (STEP_ORDER as string[]).includes(value);
}

// sessionStorage can throw (private windows, blocked site data): the flow then just restarts at Welcome on reload.
export function readStoredStep(): Step | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    return isStep(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeStep(step: Step) {
  try {
    sessionStorage.setItem(STORAGE_KEY, step);
  } catch {
    // Not remembered; harmless.
  }
}

export function clearStoredStep() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
