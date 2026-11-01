import { authClient } from '../auth';
import { Layout } from '../Layout';

export function Home() {
  const { data: session } = authClient.useSession();
  const cta = session ? (
    <a className="btn btn-primary" href="/app">
      Open your library
    </a>
  ) : (
    <a className="btn btn-primary" href="/signin">
      Sign in
    </a>
  );

  return (
    <Layout actions={cta}>
      <section className="hero">
        <h1>Read what you save, on paper.</h1>
        <p>
          Forward the articles you save from Hacker News, blogs and newsletters. Paperbrew turns them into a magazine
          you print at home.
        </p>
        {cta}
      </section>
    </Layout>
  );
}
