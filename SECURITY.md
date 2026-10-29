# Security Policy

## Reporting a Vulnerability

We take the security of RootInbox seriously. If you discover a vulnerability or security issue, please follow these guidelines to disclose it responsibly.

### 1. Private Vulnerability Reporting (Preferred)

Please use GitHub's **Private Vulnerability Reporting** feature:
1. Navigate to the **Security** tab of the `yasinif/Rootinbox` repository.
2. Click **Report a vulnerability**.
3. Fill out the report form with:
   - Type of vulnerability (e.g., cryptographic flaw, injection, privilege escalation)
   - Step-by-step reproduction instructions or proof-of-concept
   - Impact assessment
   - Any suggested mitigations

This opens a confidential advisory channel accessible only to maintainers and the reporter.

### 2. Encrypted Email Reporting

Alternatively, you may reach maintainers via:
- **Email**: `294417245+yasinif@users.noreply.github.com`
- Please include `[SECURITY] RootInbox Vulnerability Report` in the subject line.

---

## Response Process & SLA

1. **Initial Acknowledgment**: Maintainers will acknowledge receipt within 48 hours.
2. **Triage & Assessment**: Maintainers will confirm severity and scope within 5 business days.
3. **Patch & Release**: A fix will be developed in a private branch, verified against security regression tests, and published alongside a coordinated security release.
4. **Credit**: We will credit the researcher in release notes and advisory publications unless anonymity is requested.

---

## Scope & Out-of-Scope

### In Scope
- Cryptographic bypasses or zero-knowledge leakage
- Authentication and session bypasses (including `/admin` endpoints)
- Remote Code Execution (RCE) or SQL injection
- Server-Side Request Forgery (SSRF)
- Turn/STUN packet forgery or unauthorized relay abuse

### Out of Scope
- Denial of Service attacks that require overwhelming raw network bandwidth
- Social engineering attacks against maintainers
- Issues reported in outdated or unsupported forks
