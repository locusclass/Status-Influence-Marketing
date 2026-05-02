// apps/api/src/server.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import { ADMIN_MODULE_ADMIN_MANAGEMENT, ADMIN_MODULE_AUDIT_LOGS, ADMIN_MODULE_CAMPAIGNS, ADMIN_MODULE_CONTRACTS, ADMIN_MODULE_DRAFTS, ADMIN_MODULE_ESCROWS, ADMIN_MODULE_FINANCE, ADMIN_MODULE_GATEWAY, ADMIN_MODULE_JOBS, ADMIN_MODULE_MANAGER_PAYOUTS, ADMIN_MODULE_OVERVIEW, ADMIN_MODULE_PAYOUT_REQUESTS, ADMIN_MODULE_PROOFS, ADMIN_MODULE_RISK, ADMIN_MODULE_SESSIONS, ADMIN_MODULE_USERS, ADMIN_MODULE_WALLETS, ADMIN_MODULE_WITHDRAWALS, } from '@prime/shared';
import { config, hasValidYoKeys, hasYoClientCredentials, hasYoSecretKey, resolveYoBaseUrl, resolveYoFallbackBaseUrl, } from './config.js';
import { withTransaction } from './db.js';
import { authRoutes, campaignRoutes, campaignDraftRoutes, healthRoutes, paymentRoutes, uploadRoutes, verificationRoutes, chatRoutes, accountRoutes, adminRoutes, tenantAdminRoutes } from './routes/index.js';
import { ensureUserSignalSchema, touchUserPresence, } from './services/userSignals.js';
import { hasAdminModuleAccess, loadDashboardAccessContext, } from './services/adminTenant.js';
import { buildPolicyAcceptanceState, ensurePolicyAcceptanceColumns, hasAcceptedRequiredPolicies, isPolicyAcceptanceBypassRoute, loadUserPolicyAcceptance, } from './services/policies.js';
export function buildServer() {
    const skipOptionalStartupWarmups = process.env.SKIP_OPTIONAL_STARTUP_WARMUPS === '1';
    const adminTestRouteProfile = process.env.TEST_ROUTE_SCOPE?.trim().toLowerCase() === 'admin';
    const resolveAdminModuleForPath = (value) => {
        const path = value.split('?')[0] ?? value;
        const normalized = path.startsWith('/api/') ? path.slice(4) : path;
        if (normalized === '/admin/overview')
            return ADMIN_MODULE_OVERVIEW;
        if (normalized.startsWith('/admin/audit'))
            return ADMIN_MODULE_AUDIT_LOGS;
        if (normalized.startsWith('/admin/finance'))
            return ADMIN_MODULE_FINANCE;
        if (normalized.startsWith('/admin/verification-sessions')) {
            return ADMIN_MODULE_SESSIONS;
        }
        if (normalized.startsWith('/admin/campaign-drafts'))
            return ADMIN_MODULE_DRAFTS;
        if (normalized.startsWith('/admin/trust') ||
            normalized.startsWith('/admin/device-fingerprints')) {
            return ADMIN_MODULE_RISK;
        }
        if (normalized.startsWith('/admin/wallet-withdrawals')) {
            return ADMIN_MODULE_WITHDRAWALS;
        }
        if (normalized.startsWith('/admin/users'))
            return ADMIN_MODULE_USERS;
        if (normalized.startsWith('/admin/admins')) {
            return ADMIN_MODULE_ADMIN_MANAGEMENT;
        }
        if (normalized.startsWith('/admin/campaigns'))
            return ADMIN_MODULE_CAMPAIGNS;
        if (normalized.startsWith('/admin/proofs'))
            return ADMIN_MODULE_PROOFS;
        if (normalized.startsWith('/admin/wallets'))
            return ADMIN_MODULE_WALLETS;
        if (normalized.startsWith('/admin/escrows'))
            return ADMIN_MODULE_ESCROWS;
        if (normalized.startsWith('/admin/payouts'))
            return ADMIN_MODULE_MANAGER_PAYOUTS;
        if (normalized.startsWith('/admin/payout-requests')) {
            return ADMIN_MODULE_PAYOUT_REQUESTS;
        }
        if (normalized.startsWith('/admin/contracts'))
            return ADMIN_MODULE_CONTRACTS;
        if (normalized.startsWith('/admin/jobs'))
            return ADMIN_MODULE_JOBS;
        if (normalized.startsWith('/admin/yo-uganda') ||
            normalized.startsWith('/admin/flutterwave')) {
            return ADMIN_MODULE_GATEWAY;
        }
        return null;
    };
    const app = Fastify({
        pluginTimeout: Number(process.env.FASTIFY_PLUGIN_TIMEOUT ?? 30000),
        logger: {
            level: process.env.LOG_LEVEL ?? 'info'
        }
    });
    const defaultAllowedOrigins = [
        'https://primestatus.site',
        'https://*.primestatus.site',
        'https://prime-status-1f0ad.firebaseapp.com',
        'https://prime-status-1f0ad.web.app',
        'https://admindashboard-77cc3.firebaseapp.com',
        'https://admindashboard-77cc3.web.app',
        'http://localhost:*',
        'http://127.0.0.1:*',
    ];
    const configuredOrigins = config.corsOrigin
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    const allowedOrigins = [
        ...configuredOrigins,
        ...defaultAllowedOrigins,
    ].filter((origin, index, list) => list.indexOf(origin) === index);
    const isOriginAllowed = (origin) => {
        if (!origin)
            return true;
        if (allowedOrigins.includes('*'))
            return true;
        const wildcardMatch = (value, mask) => {
            if (!mask.includes('*'))
                return value === mask;
            const segments = mask.split('*');
            let cursor = 0;
            for (let index = 0; index < segments.length; index += 1) {
                const segment = segments[index] ?? '';
                if (!segment)
                    continue;
                const foundAt = value.indexOf(segment, cursor);
                if (foundAt < 0)
                    return false;
                if (index === 0 && !mask.startsWith('*') && foundAt !== 0)
                    return false;
                cursor = foundAt + segment.length;
            }
            const last = segments[segments.length - 1] ?? '';
            if (!mask.endsWith('*') && !value.endsWith(last))
                return false;
            return true;
        };
        for (const allowed of allowedOrigins) {
            if (!allowed)
                continue;
            if (wildcardMatch(origin, allowed))
                return true;
        }
        return false;
    };
    app.register(cors, {
        origin: (origin, cb) => {
            cb(null, isOriginAllowed(origin));
        },
        credentials: true,
    });
    app.register(rateLimit, {
        max: 100,
        timeWindow: '1 minute',
    });
    app.register(jwt, {
        secret: config.jwtSecret,
    });
    app.register(multipart);
    app.addHook('onReady', async () => {
        if (skipOptionalStartupWarmups) {
            return;
        }
        await withTransaction(async (client) => {
            await ensureUserSignalSchema(client);
            await ensurePolicyAcceptanceColumns(client);
        });
    });
    app.addContentTypeParser(/^application\/([a-z0-9.+-]+\+)?json(?:;.*)?$/i, { parseAs: 'string' }, (request, body, done) => {
        request.rawBody = body;
        if (!body) {
            done(null, {});
            return;
        }
        try {
            done(null, JSON.parse(body));
        }
        catch (error) {
            done(error, undefined);
        }
    });
    app.addHook('onRequest', async (request) => {
        request.log.info({
            reqId: request.id,
            method: request.method,
            url: request.url,
            ip: request.ip,
            userAgent: request.headers['user-agent']
        }, `request:start ${request.method} ${request.url}`);
    });
    app.addHook('onResponse', async (request, reply) => {
        request.log.info({
            reqId: request.id,
            method: request.method,
            url: request.url,
            statusCode: reply.statusCode,
            responseTimeMs: Number(reply.elapsedTime.toFixed(1))
        }, `request:done ${request.method} ${request.url} -> ${reply.statusCode}`);
    });
    app.addHook('onError', async (request, reply, error) => {
        request.log.error({
            reqId: request.id,
            method: request.method,
            url: request.url,
            statusCode: reply.statusCode,
            err: error
        }, `request:error ${request.method} ${request.url}`);
    });
    app.setErrorHandler((error, request, reply) => {
        request.log.error({
            reqId: request.id,
            method: request.method,
            url: request.url,
            err: error
        }, `unhandled:error ${request.method} ${request.url}`);
        if (reply.sent)
            return;
        reply.status(error.statusCode ?? 500).send({
            error: error.statusCode && error.statusCode < 500 ? error.message : 'internal_server_error'
        });
    });
    app.decorate('authenticate', async (request, reply) => {
        try {
            await request.jwtVerify();
        }
        catch {
            reply.code(401).send({ error: 'unauthorized' });
            return;
        }
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId) {
            return reply.code(401).send({ error: 'unauthorized' });
        }
        void touchUserPresence(userId).catch(() => { });
        if (isPolicyAcceptanceBypassRoute(request)) {
            return;
        }
        const acceptance = await withTransaction(async (client) => loadUserPolicyAcceptance(client, userId));
        if (!acceptance || !hasAcceptedRequiredPolicies(acceptance)) {
            return reply.code(428).send({
                error: 'policy_acceptance_required',
                ...buildPolicyAcceptanceState(acceptance ?? {}),
            });
        }
    });
    app.decorate('adminOnly', async (request, reply) => {
        try {
            await request.jwtVerify();
        }
        catch {
            return reply.code(401).send({ error: 'unauthorized' });
        }
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId) {
            return reply.code(401).send({ error: 'unauthorized' });
        }
        void touchUserPresence(userId).catch(() => { });
        // Admin dashboard access is enforced by RBAC and admin-account status.
        // End-user policy acceptance should not block internal dashboard access.
        const access = await withTransaction(async (client) => loadDashboardAccessContext(client, userId));
        if (!access || access.admin_role === 'USER') {
            return reply.code(403).send({ error: 'forbidden' });
        }
        if (access.admin_status !== 'ACTIVE') {
            return reply.code(403).send({
                error: access.admin_status === 'SUSPENDED' ? 'admin_suspended' : 'forbidden',
            });
        }
        const requiredModule = resolveAdminModuleForPath(request.url);
        if (requiredModule && !hasAdminModuleAccess(access, requiredModule)) {
            return reply.code(403).send({ error: 'forbidden' });
        }
        request.adminAccess = access;
    });
    if (!skipOptionalStartupWarmups) {
        app.register(swagger, {
            openapi: {
                info: {
                    title: 'Prime API',
                    version: '0.1.0',
                },
            },
        });
        app.register(swaggerUi, { routePrefix: '/docs' });
    }
    const registerRoutes = (instance) => {
        if (adminTestRouteProfile) {
            instance.register(healthRoutes);
            instance.register(adminRoutes);
            instance.register(tenantAdminRoutes);
            return;
        }
        instance.register(healthRoutes);
        instance.register(authRoutes);
        instance.register(campaignRoutes);
        instance.register(campaignDraftRoutes);
        instance.register(verificationRoutes);
        instance.register(uploadRoutes);
        instance.register(paymentRoutes);
        instance.register(chatRoutes);
        instance.register(accountRoutes);
        instance.register(adminRoutes);
        instance.register(tenantAdminRoutes);
    };
    // Routes
    registerRoutes(app);
    if (!adminTestRouteProfile) {
        app.register(async (instance) => registerRoutes(instance), { prefix: '/api' });
    }
    // Final payment-provider configuration
    app.addHook('onReady', async () => {
        if (skipOptionalStartupWarmups) {
            return;
        }
        await withTransaction(async (client) => {
            await ensureUserSignalSchema(client);
        });
        const hasSecret = hasYoSecretKey();
        const hasClientCreds = hasYoClientCredentials();
        app.log.info({
            provider: 'YO_UGANDA',
            base_url: resolveYoBaseUrl(),
            fallback_base_url: resolveYoFallbackBaseUrl(),
            auth_mode: hasClientCreds ? 'api_credentials' : 'none',
            has_secret: hasSecret,
            has_client_creds: hasClientCreds,
            allow_direct_api_bypass: config.yo.allowDirectApiBypass,
        }, 'yo_uganda_config');
        if (!hasValidYoKeys()) {
            app.log.warn('YO Uganda credentials are incomplete. Payments will fail.');
        }
        if (!config.yo.webhookSecretHash) {
            app.log.info('YO Uganda collection uses status polling. Webhook verification is not active.');
        }
        if (config.yo.allowDirectApiBypass) {
            app.log.warn('YO_ALLOW_DIRECT_API_BYPASS is enabled. Direct YO hosts can bypass the static-IP gateway.');
        }
    });
    return app;
}
