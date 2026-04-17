/**
 * Send an SMS (or MMS, if `mediaUrl` is provided) via Twilio REST API.
 *
 * @param {object} opts
 * @param {string} opts.to       Recipient phone number (E.164 format, e.g. +13135551234)
 * @param {string} opts.body     Message text
 * @param {string} opts.accountSid  Twilio Account SID
 * @param {string} opts.authToken   Twilio Auth Token
 * @param {string} opts.from        Twilio phone number (E.164)
 * @param {(string|string[])} [opts.mediaUrl]  One or more public URLs — turns the send into MMS.
 *   Twilio accepts up to 10 MediaUrl parameters per message.
 * @returns {{ ok: boolean, sid?: string, error?: string }}
 */
export async function sendSMS({ to, body, accountSid, authToken, from, mediaUrl }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const params = new URLSearchParams();
  params.set('From', from);
  params.set('To', to);
  params.set('Body', body);
  if (mediaUrl) {
    const urls = Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl];
    for (const u of urls) params.append('MediaUrl', u);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await res.json();

  if (res.ok) {
    return { ok: true, sid: data.sid };
  }
  return { ok: false, error: data.message || JSON.stringify(data) };
}
