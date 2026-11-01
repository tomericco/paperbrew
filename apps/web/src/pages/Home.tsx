import { authClient } from '../auth';

export function Home() {
  const { data: session } = authClient.useSession();
  return (
    <main>
      <h1>Paperbrew</h1>
      <p>Turn the articles you save into a magazine you print at home.</p>
      {session ? <a href="/app">Open your library</a> : <a href="/signin">Sign in</a>}
    </main>
  );
}
