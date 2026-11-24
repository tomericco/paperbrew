import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { DOT_COUNT } from './steps';

/** Set by the flow: moves straight to the Done card. */
export const SkipContext = createContext<(() => void) | null>(null);

/**
 * The frame every onboarding card sits in: "Step n of 5" dots above (only for steps 1 to 5; other cards
 * keep the space so the card does not jump), the card itself, and a "Skip setup" link below.
 * `footer` is the button row; put `<span className="ob-grow" />` between a left and a right button.
 */
export function Card({
  step,
  children,
  footer,
  skippable = true,
}: {
  step?: 1 | 2 | 3 | 4 | 5;
  children: ReactNode;
  footer?: ReactNode;
  /** The "Skip setup" link; the Done card turns it off. */
  skippable?: boolean;
}) {
  const skip = useContext(SkipContext);
  return (
    <>
      {step ? (
        <div className="ob-dots">
          {Array.from({ length: DOT_COUNT }, (_, i) => (
            <i key={i} className={i < step ? 'is-on' : undefined} aria-hidden="true" />
          ))}
          <span>
            Step {step} of {DOT_COUNT}
          </span>
        </div>
      ) : (
        <div className="ob-dots" aria-hidden="true" />
      )}
      <section className="ob-card">
        {children}
        {footer && <div className="ob-foot">{footer}</div>}
      </section>
      {skippable && skip && (
        <p className="ob-skip">
          <button type="button" className="ob-link" onClick={skip}>
            Skip setup
          </button>
        </p>
      )}
    </>
  );
}
