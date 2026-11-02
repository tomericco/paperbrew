import { authClient } from '../auth';
import { Layout } from '../Layout';

export function Home() {
  const { data: session } = authClient.useSession();

  return (
    <Layout centered>
      <section className="hero">
        <h1>Read what you save, on paper.</h1>
        <p>
          Forward the articles you save from Hacker News, Substack, blogs and newsletters. Paperbrew turns them into a
          magazine you print at home.
        </p>
        {/* Signed-out visitors sign in first; the library shows their forwarding address. */}
        <a className="btn btn-primary" href={session ? '/app' : '/signin'}>
          Add articles
        </a>
      </section>
    </Layout>
  );
}
