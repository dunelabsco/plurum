# Supabase Email Templates

Branded HTML templates for transactional auth emails. Paste each file's
contents into the matching template in Supabase:

**Dashboard → Authentication → Email Templates**

| File | Supabase template |
| --- | --- |
| `confirm-signup.html` | Confirm signup |
| `magic-link.html` | Magic link |
| `invite.html` | Invite user |
| `reset-password.html` | Reset password |
| `change-email.html` | Change email address |

Each template uses Supabase's standard variables:

- `{{ .ConfirmationURL }}` — the action link
- `{{ .Email }}` — the recipient
- `{{ .Token }}` / `{{ .TokenHash }}` — if needed
- `{{ .SiteURL }}` — your configured Site URL (set to `https://plurum.ai`)

After pasting:

1. Set **Subject** for each template (suggested subjects are at the top
   of each file as `<!-- subject: ... -->`)
2. Verify the **Site URL** in Authentication → URL Configuration is set
   to `https://plurum.ai`
3. Send yourself a test using the dashboard's "Send test email" feature
