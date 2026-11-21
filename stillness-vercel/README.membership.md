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
