import { authClient } from '../../auth';

/** The header's right side on the desk and Issues: who is signed in, and Sign out. */
export function AccountActions({ name }: { name: string }) {
  async function signOut() {
    await authClient.signOut();
    location.assign('/');
  }

  return (
    <>
      <span className="who">{name}</span>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}
