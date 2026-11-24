/** A GET that sends a signed-out user to sign-in. A failed or unavailable request is null: the card then says so. */
export async function load<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(path, { signal });
    if (res.status === 401 && !signal?.aborted) {
      location.replace('/signin');
      return null;
    }
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}
