import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { authClient } from '../../auth';
import { Layout } from '../../Layout';
import { SkipContext } from './Card';
import { DoneCard } from './DoneCard';
import { readStoredStep, STEP_ORDER, storeStep } from './steps';
import type { CardProps, Step } from './steps';
import { Welcome } from './Welcome';

/**
 * The cards that exist. Adding one is a file plus a line here; a step with no entry is skipped, so the flow
 * works while the others are still to come. `Back` and `Continue` move between the registered ones.
 */
const CARDS: Partial<Record<Step, ComponentType<CardProps>>> = {
  welcome: Welcome,
  done: DoneCard,
};

const registered = (step: Step) => CARDS[step] !== undefined;

function initialStep(): Step {
  // The Google round trip comes back as ?gmail=connected|error and must land on the Gmail card. The query is
  // left in the URL for that card to read (and strip once it has).
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

  const move = useCallback(
    (from: Step, direction: 1 | -1) => {
      const at = STEP_ORDER.indexOf(from);
      for (let i = at + direction; i >= 0 && i < STEP_ORDER.length; i += direction) {
        if (registered(STEP_ORDER[i])) return go(STEP_ORDER[i]);
      }
    },
    [go],
  );

  const next = useCallback(() => move(step, 1), [move, step]);
  const back = useCallback(() => move(step, -1), [move, step]);
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
