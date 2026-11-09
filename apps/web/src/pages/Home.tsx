import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { authClient } from '../auth';
import { Layout } from '../Layout';

const PERSONAS = ['CEOs', 'founders', 'busy dads', 'tech geeks'];
const ROTATE_MS = 2400;

const STEPS = [
  {
    title: 'Save as you go.',
    body: 'Forward a newsletter or an article link to your private Paperbrew address. It joins your reading pile, not your inbox.',
  },
  {
    title: 'Set your brewing schedule.',
    body: 'When do you actually read? Sunday morning, the night before a flight, weekdays at 7. Pick your moments once.',
  },
  {
    title: 'Your issue prints itself.',
    body: 'Right on schedule, Paperbrew lays out your latest saves as a magazine and sends it to your home printer. Just keep it on and stocked with paper.',
  },
  {
    title: 'Read, undistracted.',
    body: 'On the sofa, in the garden, at 35,000 feet or, yes, on the toilet. No notifications, no tabs, nothing to click. Just you and the page.',
  },
];

/**
 * "for CEOs" → "for founders" → …: the words share one grid cell and slide in and out. The cell's width
 * follows the active word (measured, so font loading and resizes are covered), which keeps the centered
 * line centered while it glides to the new width.
 */
function RotatingPersona() {
  const [index, setIndex] = useState(0);
  const [width, setWidth] = useState<number>();
  const words = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % PERSONAS.length), ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  useLayoutEffect(() => {
    const el = words.current[index];
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.offsetWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [index]);

  const leaving = (index - 1 + PERSONAS.length) % PERSONAS.length;

  return (
    <span className="persona" style={{ width }}>
      {PERSONAS.map((p, i) => (
        <span
          key={p}
          ref={(el) => {
            words.current[i] = el;
          }}
          className={i === index ? 'persona-word is-active' : i === leaving ? 'persona-word is-leaving' : 'persona-word'}
        >
          {p}
        </span>
      ))}
    </span>
  );
}

export function Home() {
  const { data: session } = authClient.useSession();
  // Signed-out visitors sign in first; the library shows their forwarding address.
  const start = session ? '/app' : '/signin';

  return (
    <Layout>
      <section className="hero">
        <h1>
          <span className="visually-hidden">Distraction-free reading method for {PERSONAS.join(', ')}.</span>
          <span aria-hidden="true">
            <span className="nowrap">Distraction-free</span> reading
          </span>{' '}
          <span className="hero-for" aria-hidden="true">
            method for <RotatingPersona />
          </span>
        </h1>
        <p className="hero-lede">
          Save articles as you find them. Paperbrew prints them as a magazine on your home printer, on the schedule you
          set.
        </p>
        <a className="btn btn-primary" href={start}>
          Print your first issue
        </a>
      </section>

      <section className="method" aria-labelledby="method-title">
        <h2 id="method-title">How it works</h2>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="step">
              <span className="step-num" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </Layout>
  );
}
