export const CURRENT_PRIVACY_POLICY_VERSION = '2026-04-30';
export const CURRENT_PLATFORM_POLICY_VERSION = '2026-04-30';
function asOptionalText(value) {
    const text = String(value ?? '').trim();
    return text.length > 0 ? text : null;
}
export function policyAcceptanceSelectSql(alias = 'u') {
    return `
    ${alias}.privacy_policy_accepted_version,
    ${alias}.privacy_policy_accepted_at,
    ${alias}.platform_policy_accepted_version,
    ${alias}.platform_policy_accepted_at
  `;
}
export function buildPolicyAcceptanceState(user) {
    // Policy enforcement has been retired. Keep the old response contract so
    // existing clients continue to deserialize the same fields without blocking.
    const privacyPolicyAcceptedVersion = asOptionalText(user.privacy_policy_accepted_version ?? user.privacyPolicyAcceptedVersion) ?? CURRENT_PRIVACY_POLICY_VERSION;
    const platformPolicyAcceptedVersion = asOptionalText(user.platform_policy_accepted_version ?? user.platformPolicyAcceptedVersion) ?? CURRENT_PLATFORM_POLICY_VERSION;
    return {
        privacy_policy_required_version: CURRENT_PRIVACY_POLICY_VERSION,
        privacy_policy_accepted_version: privacyPolicyAcceptedVersion,
        privacy_policy_accepted_at: user.privacy_policy_accepted_at ?? user.privacyPolicyAcceptedAt ?? null,
        platform_policy_required_version: CURRENT_PLATFORM_POLICY_VERSION,
        platform_policy_accepted_version: platformPolicyAcceptedVersion,
        platform_policy_accepted_at: user.platform_policy_accepted_at ?? user.platformPolicyAcceptedAt ?? null,
        policies_accepted: true,
    };
}
export function hasAcceptedRequiredPolicies(user) {
    return true;
}
export function buildCurrentPolicyDocuments() {
    return {
        privacy_policy: {
            slug: 'privacy_policy',
            title: 'User Privacy Policy',
            version: CURRENT_PRIVACY_POLICY_VERSION,
            summary: 'This policy explains how Prime Status collects, uses, shares, protects, and retains personal data for account access, WhatsApp Status promotions, verification, payments, and fraud prevention.',
            sections: [
                {
                    heading: 'What We Collect',
                    body: [
                        'We collect account and profile details such as your name, email address, phone number, role, country, and optional profile media.',
                        'We process product, promotion, chat, verification, payment, payout, and support records, including media you upload and the businesses or posters you choose to engage.',
                        'We also keep device, session, and security records needed to protect the platform, investigate abuse, and maintain service reliability.',
                    ],
                },
                {
                    heading: 'Why We Use Your Data',
                    body: [
                        'We use personal data to create and secure accounts, verify WhatsApp Status posts, process payments and payouts, deliver chat and notifications, and support customer care.',
                        'We also use data to prevent fraud, enforce platform rules, comply with lawful requests, keep auditable records, and improve service performance.',
                    ],
                },
                {
                    heading: 'How We Share Data',
                    body: [
                        'We share data only where reasonably necessary with service providers such as hosting, storage, messaging, authentication, and payment partners, and with businesses or posters where disclosure is necessary to run a promotion.',
                        'We may also disclose data to regulators, courts, law-enforcement agencies, or professional advisers where required by law or reasonably necessary to protect rights, safety, or the integrity of the platform.',
                        'We do not sell personal data.',
                    ],
                },
                {
                    heading: 'Retention, Security, and Transfers',
                    body: [
                        'We retain personal data only for as long as it is reasonably required for account administration, promotions, verification, payments, disputes, audits, fraud prevention, or legal compliance.',
                        'We apply reasonable technical and organisational safeguards, access controls, logging, and review processes to reduce unauthorised access, loss, alteration, or misuse.',
                        'Where personal data is processed or stored outside Uganda, we require appropriate protections or another lawful basis permitted by the applicable Ugandan data-protection framework.',
                    ],
                },
                {
                    heading: 'Your Rights',
                    body: [
                        'Subject to applicable law, you may request access to your personal data, request correction or deletion of inaccurate or unlawfully held data, object to direct marketing, and withdraw consent where consent is the applicable legal basis.',
                        'You may also complain to the competent Ugandan authority if you believe your data has been handled unlawfully.',
                    ],
                },
            ],
            legal_references: [
                {
                    title: 'Constitution of the Republic of Uganda, Article 27 (Right to privacy)',
                    url: 'https://ulii.org/akn/ug/act/statute/1995/constitution/eng%402023-12-31/provision/chp_Four__subpart_nn_1__sec_27',
                },
                {
                    title: 'Data Protection and Privacy Act, 2019',
                    url: 'https://ulii.org/akn/ug/act/2019/9/eng%402019-05-03',
                },
                {
                    title: 'Data Protection and Privacy Regulations, 2021',
                    url: 'https://ulii.org/akn/ug/act/si/2021/21/eng%402021-03-12',
                },
            ],
        },
        platform_policy: {
            slug: 'platform_policy',
            title: 'Platform Use and Community Policy',
            version: CURRENT_PLATFORM_POLICY_VERSION,
            summary: 'This policy sets the rules for lawful use of Prime Status, including product pages, WhatsApp Status promotions, uploads, verification, and payment activity.',
            sections: [
                {
                    heading: 'Permitted Use',
                    body: [
                        'Prime Status may only be used for lawful product promotion through WhatsApp Status, proof submission, payment activity, and related business communication.',
                        'You must use accurate account information, act on your own authority or on behalf of a properly authorised business, and keep your credentials and device access secure.',
                    ],
                },
                {
                    heading: 'Prohibited Conduct',
                    body: [
                        'You must not use the platform for fraud, impersonation, unlawful surveillance, harassment, extortion, hate activity, violence, child exploitation, adult sexual exploitation, unlawful data disclosure, malicious software, or any promotion or communication that is illegal or misleading under Ugandan law.',
                        'You must not upload or promote content that infringes privacy, intellectual property, confidentiality, or other legal rights, or that advertises restricted or unlawful goods, services, schemes, or claims.',
                    ],
                },
                {
                    heading: 'Beneficiary, Contact, and Chat Data',
                    body: [
                        'You may only upload, search, or use names, phone numbers, group records, and related identifiers where you have a lawful basis and operational need connected to the platform.',
                        'You must not scrape, resell, mass-export, or reuse contact data obtained through the platform for unrelated marketing or unlawful profiling.',
                    ],
                },
                {
                    heading: 'Promotions, Proof, and Payments',
                    body: [
                        'Promotions, offers, approvals, proof submissions, and payment-related records must be truthful, complete, and not manipulated. Fabricated proof, collusive conduct, refund abuse, off-platform settlement evasion, or payout fraud is prohibited.',
                        'Platform records, audit trails, and authenticated electronic acceptances may be relied upon for operational enforcement and dispute handling.',
                    ],
                },
                {
                    heading: 'Enforcement',
                    body: [
                        'We may reject content, restrict features, reverse access, freeze payouts where reasonably necessary, suspend or terminate accounts, and cooperate with regulators or law-enforcement authorities where required or justified.',
                        'Serious or repeated violations may result in permanent removal and preservation of records for investigation, dispute resolution, or legal compliance.',
                    ],
                },
            ],
            legal_references: [
                {
                    title: 'Computer Misuse Act',
                    url: 'https://ulii.org/akn/ug/act/2011/2',
                },
                {
                    title: 'Electronic Transactions Act',
                    url: 'https://ulii.org/akn/ug/act/2011/8/eng%402011-03-18',
                },
                {
                    title: 'Data Protection and Privacy Act, 2019',
                    url: 'https://ulii.org/akn/ug/act/2019/9/eng%402019-05-03',
                },
            ],
        },
    };
}
export async function ensurePolicyAcceptanceColumns(client) {
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS privacy_policy_accepted_version TEXT,
      ADD COLUMN IF NOT EXISTS privacy_policy_accepted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS platform_policy_accepted_version TEXT,
      ADD COLUMN IF NOT EXISTS platform_policy_accepted_at TIMESTAMPTZ
  `);
}
export async function loadUserPolicyAcceptance(client, userId) {
    await ensurePolicyAcceptanceColumns(client);
    const result = await client.query(`
    SELECT
      id,
      status,
      status_reason,
      status_reason_updated_at,
      privacy_policy_accepted_version,
      privacy_policy_accepted_at,
      platform_policy_accepted_version,
      platform_policy_accepted_at
    FROM users
    WHERE id = $1
    LIMIT 1
    `, [userId]);
    return result.rows[0] ?? null;
}
export function isPolicyAcceptanceBypassRoute(request) {
    const method = String(request.method ?? 'GET').trim().toUpperCase();
    const routeUrl = String(request.routeOptions?.url ?? '').trim();
    const normalizedRouteUrl = routeUrl.replace(/^\/api(?=\/|$)/, '') || routeUrl;
    if (method === 'GET' && normalizedRouteUrl === '/account/me') {
        return true;
    }
    if (method === 'GET' && normalizedRouteUrl === '/account/policies') {
        return true;
    }
    if (method === 'POST' &&
        normalizedRouteUrl === '/account/policies/accept') {
        return true;
    }
    return false;
}
