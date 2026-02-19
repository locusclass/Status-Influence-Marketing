import { z } from 'zod';
import { withTransaction } from '../db.js';
import { UserRepo } from '../repositories/userRepo.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
const registerSchema = z.object({
    email: z.string().email(),
    phone: z.string().min(7).max(20),
    password: z.string().min(8),
    role: z.enum(['ADVERTISER', 'DISTRIBUTOR'])
});
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8)
});
export async function authRoutes(app) {
    const userRepo = new UserRepo();
    app.post('/auth/register', async (request, reply) => {
        const body = registerSchema.parse(request.body);
        const user = await withTransaction(async (client) => {
            const existing = await userRepo.findByEmail(client, body.email);
            if (existing) {
                reply.code(400);
                return { error: 'email_taken' };
            }
            const created = await userRepo.createUser(client, body.email, body.phone, hashPassword(body.password), body.role);
            await userRepo.ensureWallet(client, created.id);
            return created;
        });
        if (user.error)
            return user;
        const token = app.jwt.sign({ sub: user.id, role: user.role });
        return { token, user: { id: user.id, email: user.email, role: user.role, phone: user.phone } };
    });
    app.post('/auth/login', async (request, reply) => {
        const body = loginSchema.parse(request.body);
        const user = await withTransaction(async (client) => userRepo.findByEmail(client, body.email));
        if (!user || !verifyPassword(body.password, user.password_hash)) {
            reply.code(401);
            return { error: 'invalid_credentials' };
        }
        const token = app.jwt.sign({ sub: user.id, role: user.role });
        return { token, user: { id: user.id, email: user.email, role: user.role, phone: user.phone } };
    });
}
