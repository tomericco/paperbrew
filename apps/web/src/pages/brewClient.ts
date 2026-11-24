import { errorText } from './layouts';

/**
 * Brews the magazine and saves the PDF through a temporary link click. With `ids` it brews just those articles
 * (the API takes at most 50); without, everything saved. Returns the file name and the ids that went into the
 * PDF (from `x-brew-article-ids`), which can be fewer than asked for if one was archived meanwhile.
 * Throws an `Error` whose message is the API's `error`, or "Brewing failed.".
 */
export async function downloadBrew(ids?: string[]): Promise<{ filename: string; ids: string[] }> {
  const failed = 'Brewing failed.';
  let res: Response;
  let blob: Blob;
  let apiError: string | null = null;
  try {
    res = await fetch(ids ? `/api/brew?ids=${ids.map(encodeURIComponent).join(',')}` : '/api/brew');
    if (!res.ok) {
      apiError = await errorText(res, failed);
      throw new Error(apiError);
    }
    blob = await res.blob();
  } catch {
    // The API's own message when it gave one; a network failure is just "Brewing failed.".
    throw new Error(apiError ?? failed);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? 'paperbrew.pdf';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari can cancel the download if the URL is revoked in the same task as the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  // Exactly what is in this PDF, so archiving never touches an article that arrived mid-brew.
  return { filename, ids: (res.headers.get('x-brew-article-ids') ?? '').split(',').filter(Boolean) };
}
