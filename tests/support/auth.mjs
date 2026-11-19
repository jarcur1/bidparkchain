/**
 * Signs `wallet` in to the API at `url` and returns the session cookie ("name=value") to send back.
 * Requests carry no Origin header, so the session is bound to the API's own origin.
 */
export async function signInCookie(url, wallet) {
  const post = (route, body) => fetch(`${url}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const { nonce, message } = await (await post('/api/auth/nonce', { address: wallet.address })).json();
  const verified = await post('/api/auth/verify', { nonce, signature: await wallet.signMessage(message) });
  if (!verified.ok) throw new Error(`Sign-in failed: ${(await verified.json()).error}`);
  return verified.headers.get('set-cookie').split(';')[0];
}
