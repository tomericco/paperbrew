import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { authClient } from '../../auth';
import { Layout } from '../../Layout';
import { load } from './api';
import { SkipContext } from './Card';
import { DoneCard } from './DoneCard';
import { FirstIssueCard } from './FirstIssueCard';
import { GmailCard } from './GmailCard';
import { LookCard } from './LookCard';
import { PrinterCard } from './PrinterCard';
import { ScheduleCard } from './ScheduleCard';
import { readStoredStep, STEP_ORDER, storeStep } from './steps';
import type { CardProps, Step } from './steps';
import { Welcome } from './Welcome';

/**
 * The cards that exist. Adding one is a file plus a line here; a step with no entry is skipped, so the flow
 * works while the others are still to come. `Back` and `Continue` move between the registered ones.
 */
const CARDS: Partial<Record<Step, ComponentType<CardProps>>> = {
  welcome: Welcome,
  gmail: GmailCard,
  look: LookCard,
  first: FirstIssueCard,
  schedule: ScheduleCard,
  printer: PrinterCard,
  done: DoneCard,
};

const registered = (step: Step) => CARDS[step] !== undefined;

/** Cards with nothing to offer on this server; see `Flow`. */
function isSkipped(step: Step, available: { schedule: boolean; printer: boolean }): boolean {
  return (step === 'schedule' && !available.schedule) || (step === 'printer' && !available.printer);
}

function initialStep(): Step {
  // The Google round trip comes back as ?gmail=connected|error and must land on the Gmail card. The query is
  // left in the URL for that card to read and strip (so a later reload does not force it again).
  const outcome = new URLSearchParams(location.search).get('gmail');
  if ((outcome === 'connected' || outcome === 'error') && registered('gmail')) return 'gmail';
  const stored = readStoredStep();
  return stored !== null && registered(stored) ? stored : 'welcome';
}

/** The first-run flow at /app/welcome: one card at a time, every card skippable. */
export function Onboarding() {
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) location.replace('/signin');
  }, [isPending, session]);

  if (isPending || !session) return <Layout>{null}</Layout>;
  return (
    <Layout>
      <Flow />
    </Layout>
  );
}

function Flow() {
  const [step, setStep] = useState<Step>(initialStep);
  const firstRender = useRef(true);

  const go = useCallback((to: Step) => {
    storeStep(to);
    setStep(to);
  }, []);

  // Two cards can have nothing to offer: Schedule when the server has no scheduler, Printer when there is no Mac app
  // to download (the same rules as Settings). They are passed over in both directions, so Back never bounces forward
  // again. Asked once; a failed request counts as available, since the card then says so itself. The dots still
  // read "Step n of 5".
  const availability = useRef<Promise<{ schedule: boolean; printer: boolean }> | undefined>(undefined);
  const getAvailability = useCallback(() => {
    availability.current ??= load<{ scheduleAvailable: boolean; macAppUrl: string | null }>('/api/me').then((me) => ({
      schedule: me?.scheduleAvailable !== false,
      printer: me === null || !!me.macAppUrl,
    }));
    return availability.current;
  }, []);

  const move = useCallback(
    async (from: Step, direction: 1 | -1) => {
      const available = await getAvailability();
      const at = STEP_ORDER.indexOf(from);
      for (let i = at + direction; i >= 0 && i < STEP_ORDER.length; i += direction) {
        const candidate = STEP_ORDER[i];
        if (!registered(candidate) || isSkipped(candidate, available)) continue;
        return go(candidate);
      }
    },
    [go, getAvailability],
  );

  // A reload on a card that is now passed over goes on to the nearest card after it.
  const opened = useRef(step);
  useEffect(() => {
    void getAvailability().then((available) => {
      if (isSkipped(opened.current, available)) void move(opened.current, 1);
    });
  }, [getAvailability, move]);

  const next = useCallback(() => void move(step, 1), [move, step]);
  const back = useCallback(() => void move(step, -1), [move, step]);
  const skip = useCallback(() => go('done'), [go]);

  // A new card takes focus on its heading, so a keyboard or screen reader user lands on it.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>('.ob-card :is(h1, h2)');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
  }, [step]);

  const Current = CARDS[step] ?? Welcome;
  return (
    <div className="ob">
      <SkipContext.Provider value={skip}>
        <Current key={step} next={next} back={back} />
      </SkipContext.Provider>
    </div>
  );
}
