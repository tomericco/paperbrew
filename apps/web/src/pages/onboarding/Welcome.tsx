import type { ReactNode } from 'react';
import { Card } from './Card';
import type { CardProps } from './steps';

function Beat({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <li>
      <svg
        viewBox="0 0 44 44"
        width="44"
        height="44"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
      <div>
        <h3>{title}</h3>
        <p className="ob-muted">{text}</p>
      </div>
    </li>
  );
}

export function Welcome({ next }: CardProps) {
  return (
    <Card
      footer={
        <button type="button" className="btn-primary ob-block" onClick={next}>
          Get started
        </button>
      }
    >
      <div className="ob-eyebrow">Welcome to Paperbrew</div>
      <h1>Read what you saved, on paper.</h1>
      <p className="ob-muted ob-lede">
        You save more than you read. Paperbrew turns those saves into a magazine you read away from screens. Let's set it up
        in 3 mins.
      </p>
      <ul className="ob-beats">
        <Beat title="Save" text="Newsletters and articles you forward collect in a pile, not in your inbox.">
          <rect x="8" y="9" width="28" height="26" rx="3" />
          <path d="M8 17l14 9 14-9" />
        </Beat>
        <Beat title="Brew" text="Paperbrew lays the pile out as a magazine, by hand or on a schedule.">
          <rect x="9" y="6" width="26" height="32" rx="2" />
          <path d="M15 15h14M15 21h14M15 27h8" />
        </Beat>
        <Beat title="Print" text="Download it, or let it print itself on your home printer.">
          <path d="M13 16V7h18v9" />
          <rect x="6" y="16" width="32" height="14" rx="2" />
          <rect x="13" y="25" width="18" height="12" />
        </Beat>
      </ul>
    </Card>
  );
}
