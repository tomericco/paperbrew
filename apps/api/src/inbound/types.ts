/** Provider-neutral shape of an email we received. Add adapters (Cloudflare, SES, Mailgun) that produce this. */
export interface InboundEmail {
  provider: 'postmark';
  providerMessageId: string;
  messageId: string | null;
  from: string; // lowercased address of the sender (the user, when forwarding)
  recipients: string[]; // every address it was sent to, lowercased
  subject: string;
  date: string | null;
  text: string;
  html: string;
  listUnsubscribe: string | null; // present when a newsletter was sent straight to the Paperbrew address
}
