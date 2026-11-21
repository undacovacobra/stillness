# Stillness membership deployment

Deploy this branch to the separate `stillness-members` project. The membership applies to the clone and uses a separate Supabase project, Stripe environment, and Gemini credentials.

## Launch configuration

| Service | Values and settings |
| --- | --- |
| Vercel | `APP_ORIGIN` set to the clone URL. Use `MEMBERS_COOKIE_SECRET` with at least 32 random characters. Set `MEMBER_ADMIN_EMAILS` to the comma-separated verified owner accounts. |
| Supabase | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and server-only `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`). Apply `supabase/migrations/20261121230504_stillness_membership.sql` only to the membership database. Set Auth site URL and allowlist the exact `/?flow=signup` and `/?flow=recovery` callback URLs. Require email confirmation, keep anonymous signups off, and configure production SMTP before issuing public invitations. |
| Google | Server-only `GEMINI_API_KEY` for a billing-enabled Gemini project. Check current text and speech model quotas in AI Studio before public launch. |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_MONTHLY_PRICE_ID`, `STRIPE_TOPUP_PRICE_ID`. Create prices in the same Stripe mode for 11.99 USD per month and 4.99 USD one-time. Enable only card trial collection. Set `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` if using a dedicated self-service configuration. |

Configure the Stripe customer portal to allow updating payment details, viewing invoices, and canceling at period end. Keep plan switching off for this single-plan launch. Register `/api/stripe-webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Use the endpoint-specific signing secret.

The trial provides 15 narrated minutes for 10 days and requires a Stripe card setup. One card can unlock one trial. A successful first or renewal invoice supplies 120 minutes for that billing period. The one-time pack adds 60 minutes. Customers manage billing in Stripe and see entitlements in Profile.

Run `npm test` in this directory. Then verify signup and recovery by email, Stripe test checkout, a repeated trial card, simulated renewal and cancellation, top-up, quota exhaustion, and a voice preview followed by a session. Confirm owners can see usage and ordinary accounts cannot access the owner view. In preview environments keep payments in Stripe test mode. Set `STRIPE_LIVE_ENABLED=true` only after merchant onboarding, public terms and privacy notice, production email, launch market and payment settings, and verification are complete.

## Capacity before launch

Supabase's monthly active user allowance and Vercel's concurrency ceiling do not establish concurrent meditation capacity. Configure a production email provider and test a realistic signup burst. Measure narration requests per session, peak starts per minute, provider errors, and preparation latency. Compare those numbers to the Gemini project's live limits before scaling invites. Use staging and synthetic responses for load testing so that it does not send real email or incur voice generation charges.

## Google and Apple sign-in

On the membership Supabase project, add `https://stillness-members.vercel.app/?flow=oauth` to Auth's redirect allowlist. Set the Site URL to `https://stillness-members.vercel.app/`. The public app enables each button after the corresponding provider is enabled in this project.

- **Google.** In Google Cloud, create a Web application OAuth client. Use `https://stillness-members.vercel.app` as an authorized JavaScript origin and `https://uyoerkyccnqtjefjlsgz.supabase.co/auth/v1/callback` as the redirect URI. Set up the consent screen and add the client ID and secret to Supabase Auth's Google provider.
- **Apple.** Use an eligible Sign in with Apple-enabled App Store app and its primary App ID. Create a Services ID and configure `uyoerkyccnqtjefjlsgz.supabase.co` as the domain and `https://uyoerkyccnqtjefjlsgz.supabase.co/auth/v1/callback` as the return URL. Add the Services ID and signed client secret to Supabase Auth's Apple provider, and rotate the secret before its expiry. Apple private relay email addresses can differ from the email on an existing Stillness account.

Both providers return to Stillness through the same browser that initiated sign-in. Existing membership entitlement is looked up by the verified Supabase user ID. No provider gives an additional trial automatically.

[Supabase Google setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google) · [Supabase Apple setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-apple)
