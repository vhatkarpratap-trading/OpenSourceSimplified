# Google sign-in and PayPal Pro setup

The desktop app keeps OAuth and PayPal secrets in the Electron main process; they are never exposed to the renderer. Configure these environment variables in the process that starts Rex Canvas:

```sh
GOOGLE_CLIENT_ID=your-google-oauth-client-id
PAYPAL_CLIENT_ID=your-paypal-client-id
PAYPAL_CLIENT_SECRET=your-paypal-client-secret
PAYPAL_MONTHLY_PLAN_ID=P-...
PAYPAL_YEARLY_PLAN_ID=P-...
# Set to live only after testing in the PayPal sandbox.
PAYPAL_ENVIRONMENT=sandbox
```

In Google Cloud, create a Desktop OAuth client and register this redirect URI exactly:

```
http://127.0.0.1:53682/oauth/google/callback
```

In PayPal, create two subscription plans for the same Pro product:

- Monthly: USD 19 every month
- Yearly: USD 120 every year

Put their plan IDs in `PAYPAL_MONTHLY_PLAN_ID` and `PAYPAL_YEARLY_PLAN_ID`. Start with sandbox credentials and sandbox plans. PayPal approval opens in the default browser and the application verifies the subscription before showing Pro as active.

For a multi-device production entitlement system, also mirror PayPal subscription webhooks to your own server and make that server the authority for Pro access. The current desktop flow safely keeps the client secret out of the UI and verifies checkout with PayPal directly.
