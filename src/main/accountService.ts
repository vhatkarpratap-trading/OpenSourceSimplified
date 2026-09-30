import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

export type PlanId = 'monthly' | 'yearly';

export interface AccountState {
  configured: boolean;
  user: { email: string; name: string; picture?: string } | null;
  subscription: { plan: PlanId; status: string; id: string; renewsAt?: string } | null;
}

interface StoredAccount extends Omit<AccountState, 'configured'> {}

const GOOGLE_REDIRECT_URI = 'http://127.0.0.1:53682/oauth/google/callback';
const PAYPAL_API = process.env.PAYPAL_ENVIRONMENT === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

function configError(service: string, names: string[]): Error {
  return new Error(`${service} is not configured. Set ${names.join(' and ')} before using it.`);
}

export class AccountService {
  constructor(private readonly userDataPath: string, private readonly openExternal: (url: string) => Promise<void>) {}

  private stateFile() { return path.join(this.userDataPath, 'account.json'); }

  private read(): StoredAccount {
    try { return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) as StoredAccount; }
    catch { return { user: null, subscription: null }; }
  }

  private write(state: StoredAccount) {
    fs.writeFileSync(this.stateFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  getState(): AccountState {
    return {
      ...this.read(),
      configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_MONTHLY_PLAN_ID && process.env.PAYPAL_YEARLY_PLAN_ID),
    };
  }

  async signInWithGoogle(): Promise<AccountState> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw configError('Google sign-in', ['GOOGLE_CLIENT_ID']);
    const state = crypto.randomBytes(24).toString('hex');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: GOOGLE_REDIRECT_URI, response_type: 'code',
      scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'select_account',
    }).toString();
    const code = await this.waitForGoogleCallback(state, url.toString());
    const body = new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: GOOGLE_REDIRECT_URI });
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!tokenResponse.ok) throw new Error('Google sign-in could not be completed. Please try again.');
    const tokens = await tokenResponse.json() as { access_token?: string };
    if (!tokens.access_token) throw new Error('Google did not return an access token.');
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (!profileResponse.ok) throw new Error('Could not load your Google profile.');
    const profile = await profileResponse.json() as { email?: string; name?: string; picture?: string; email_verified?: boolean };
    if (!profile.email || !profile.email_verified) throw new Error('Please use a verified Google email address.');
    const stored = this.read();
    this.write({ ...stored, user: { email: profile.email, name: profile.name || profile.email, picture: profile.picture } });
    return this.getState();
  }

  async startSubscription(plan: PlanId): Promise<AccountState> {
    const account = this.read();
    if (!account.user) throw new Error('Sign in with Google before choosing a plan.');
    const planId = plan === 'monthly' ? process.env.PAYPAL_MONTHLY_PLAN_ID : process.env.PAYPAL_YEARLY_PLAN_ID;
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !planId) {
      throw configError('PayPal billing', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', plan === 'monthly' ? 'PAYPAL_MONTHLY_PLAN_ID' : 'PAYPAL_YEARLY_PLAN_ID']);
    }
    const token = await this.paypalAccessToken();
    const response = await fetch(`${PAYPAL_API}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'paypal-request-id': crypto.randomUUID() },
      body: JSON.stringify({ plan_id: planId, custom_id: account.user.email, application_context: { brand_name: 'Rex Canvas', user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING' } }),
    });
    if (!response.ok) throw new Error('PayPal could not start checkout. Check the plan IDs and try again.');
    const subscription = await response.json() as { id: string; links?: Array<{ rel: string; href: string }> };
    const approveUrl = subscription.links?.find(link => link.rel === 'approve')?.href;
    if (!approveUrl) throw new Error('PayPal did not provide an approval link.');
    await this.openExternal(approveUrl);
    const verified = await this.waitForSubscription(subscription.id, token);
    if (!['ACTIVE', 'APPROVED'].includes(verified.status)) throw new Error('Payment was not approved. Finish the PayPal checkout, then try again.');
    this.write({ ...account, subscription: { plan, id: subscription.id, status: verified.status, renewsAt: verified.billing_info?.next_billing_time } });
    return this.getState();
  }

  signOut(): AccountState { this.write({ user: null, subscription: null }); return this.getState(); }

  private async paypalAccessToken(): Promise<string> {
    const secret = process.env.PAYPAL_CLIENT_SECRET!; const clientId = process.env.PAYPAL_CLIENT_ID!;
    const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    if (!response.ok) throw new Error('PayPal authentication failed. Check your client credentials.');
    const data = await response.json() as { access_token?: string };
    if (!data.access_token) throw new Error('PayPal did not return an access token.');
    return data.access_token;
  }

  private waitForGoogleCallback(expectedState: string, authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', GOOGLE_REDIRECT_URI);
        if (url.pathname !== '/oauth/google/callback') { res.writeHead(404).end(); return; }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h2>You may return to Rex Canvas.</h2><p>This window can be closed.</p>');
        cleanup();
        if (error || state !== expectedState || !code) reject(new Error(error ? `Google sign-in was cancelled: ${error}` : 'Google sign-in validation failed.'));
        else resolve(code);
      });
      const timer = setTimeout(() => { cleanup(); reject(new Error('Google sign-in timed out. Please try again.')); }, 5 * 60_000);
      const cleanup = () => { clearTimeout(timer); server.close(); };
      server.once('error', () => { cleanup(); reject(new Error(`Could not listen on ${GOOGLE_REDIRECT_URI}. Close the app using that port and retry.`)); });
      server.listen(53682, '127.0.0.1', () => { void this.openExternal(authUrl).catch(error => { cleanup(); reject(error); }); });
    });
  }

  private async waitForSubscription(id: string, token: string): Promise<{ status: string; billing_info?: { next_billing_time?: string } }> {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const response = await fetch(`${PAYPAL_API}/v1/billing/subscriptions/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) continue;
      const data = await response.json() as { status: string; billing_info?: { next_billing_time?: string } };
      if (['ACTIVE', 'APPROVED', 'CANCELLED', 'SUSPENDED', 'EXPIRED'].includes(data.status)) return data;
    }
    throw new Error('Timed out waiting for PayPal approval. Your subscription may still be active; refresh the app after checkout.');
  }
}
