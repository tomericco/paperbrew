export type AppState =
  | { kind: 'not_connected' }
  | { kind: 'ready'; printer: string }
  | { kind: 'printing' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string };

export function statusText(s: AppState): string {
  switch (s.kind) {
    case 'not_connected':
      return 'Not connected';
    case 'ready':
      return `Ready · ${s.printer}`;
    case 'printing':
      return 'Printing your issue…';
    case 'offline':
      return "Can't reach Paperbrew";
    case 'error':
      return `Couldn't print: ${s.message}`;
  }
}
